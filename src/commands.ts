/**
 * Stage 4 plan command: walk a folder, run each document through Stage 1 read,
 * Stage 2 analyse and Stage 3 validate, then render a unique new name with
 * Stage 4. It renames, moves and rewrites nothing — its only output is the row
 * set, which writePlan() persists as plain JSON in `<folder>/.docnamer-plan.json`.
 */
import { analyse, isFailed, type Analysis } from './analyse.ts'
import type { Config } from './config.ts'
import { buildName } from './name.ts'
import { read, pageImages } from './read.ts'
import { setFinderTag, setFinderComments, addOcrTextLayer, SIDECAR } from './spotlight.ts'
import { validate, type Checked } from './validate.ts'

export type PlanRow = {
  old: string
  new: string
  type: string
  /**
   * Which rung of Stage 1's ladder produced the content Stage 2 classified: a
   * usable text layer, OCR above the confidence threshold, or the vision model
   * when OCR came back weak. Null when the read itself failed.
   */
  method: 'text' | 'ocr' | 'vision' | null
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

export const PLAN_FILE = '.docnamer-plan.json'

function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function extOf(p: string): string {
  const m = /\.[^./]+$/.exec(base(p))
  return m ? m[0] : ''
}

/**
 * A filename without its extension. The fallback name for a row nothing could
 * analyse is its own stem: buildName re-appends the extension, and handing it
 * the whole filename would render "scan.pdf.pdf".
 */
function stemOf(name: string): string {
  const e = extOf(name)
  return e ? name.slice(0, name.length - e.length) : name
}

/** Every non-hidden file in the folder, recursively when asked. */
async function scan(folder: string, recursive: boolean): Promise<string[]> {
  const out: string[] = []
  const pattern = recursive ? '**/*' : '*'
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: folder, onlyFiles: true })) {
    if (rel === PLAN_FILE) continue
    if (rel.split('/').some(part => part.startsWith('.'))) continue
    // An OCR sidecar is apply's own text copy of a scan, not a document: planned,
    // it would be read as text and renamed to a `.txt` of its own.
    if (rel.endsWith(SIDECAR)) continue
    out.push(rel)
  }
  out.sort()
  return out
}

export async function plan(
  folder: string,
  opts: { recursive: boolean; applyUnflagged: boolean },
  config: Config,
  progress?: Progress
): Promise<PlanRow[]> {
  const rels = await scan(folder, opts.recursive)
  const planned = new Set<string>()
  // Names already on disk are occupied too: no row may propose one.
  for (const rel of rels) planned.add(base(rel).toLowerCase())

  // Stages 1-3 are independent per file — one model call each — so they run
  // concurrently; Stage 4 below is serial because it mutates `planned`.
  // Each completion reports how many documents are done, so a terminal can
  // draw the bar rising beside the throbber while the rest are still read.
  let done = 0
  const examined = await Promise.all(
    rels.map(async rel => {
      const path = `${folder}/${rel}`
      const old = base(rel)
      let checked: Checked
      let failedReason: string | null = null
      let method: PlanRow['method'] = null
      try {
        const content = await read(path)
        // Stage 1 SKIPped the file (unsupported type): it is not a document, so
        // it gets no row. The folder's own docnamer.json is the case in point —
        // a row for it would propose its own name back at it and collide.
        if (content === null) return null
        method = content.method
        let result: Analysis | { failed: true; reason: string } = await analyse(
          content,
          old,
          config
        )
        // A reply the tool contract could not read is the one case worth a
        // second, stronger look: hand the first page's image to the strong seat
        // and take whatever name it returns.
        const images = isFailed(result as never) ? pageImages(path) : []
        if (images.length > 0) {
          result = await analyse({ ...content, images, method: 'vision' }, old, config, 'strong')
        }
        if (isFailed(result as never)) failedReason = (result as { reason: string }).reason
        else {
          checked = validate(result as Analysis, content, config)
          done += 1
          progress?.(done, rels.length, old)
          return { rel, old, checked, failedReason, method }
        }
      } catch (e) {
        failedReason = e instanceof Error ? e.message : String(e)
      }
      // A row nothing could analyse still gets a name: its own stem, which
      // Stage 4 renders unique against the names already on disk.
      checked = { type: 'other', type_confidence: 0, fields: {}, summary: stemOf(old), flags: [] }
      done += 1
      progress?.(done, rels.length, old)
      return { rel, old, checked, failedReason, method }
    })
  )

  const rows: PlanRow[] = []
  for (const ex of examined) {
    if (ex === null) continue
    const { rel, old, checked, failedReason, method } = ex
    const fields: Record<string, string> = {}
    const evidence: Record<string, string> = {}
    for (const [k, v] of Object.entries(checked.fields)) {
      // SAFE: the plan file presents what was read, and a field the model could
      // not read is null by contract — validate() has already flagged it and the
      // flags travel with the row. Writing it as empty is the plan format's own
      // spelling of "nothing", not a value invented here.
      fields[k] = v.value ?? ''
      evidence[k] = v.evidence ?? ''
    }
    const flags = [...checked.flags]
    if (failedReason !== null) flags.push(`analysis failed: ${failedReason}`)

    // EVERY row goes through Stage 4, a failed one included: a row that kept
    // its own name would propose a name already on disk by definition. buildName
    // seeds `planned` with every name on disk, so the failed row lands on the
    // stem plus a Finder-style " (2)".
    const name = await buildName(checked, config, { dir: folder, ext: extOf(old) }, planned)

    const f = Bun.file(`${folder}/${rel}`)
    rows.push({
      old,
      new: name,
      type: checked.type,
      method,
      fields,
      evidence,
      flags,
      summary: checked.summary,
      size: f.size,
      mtime: f.lastModified,
      status: 'pending'
    })
  }
  return rows
}

/** Persist the plan as plain JSON in the folder. */
export async function writePlan(folder: string, rows: PlanRow[]): Promise<void> {
  await Bun.write(`${folder}/${PLAN_FILE}`, JSON.stringify(rows, null, 2) + '\n')
}

// --- Stage 5: apply and undo --------------------------------------------------

type UndoEntry = {
  old: string
  new: string
  size: number
  mtime: number
  tag?: string
  sidecar?: string
}

type UndoRecord = { run: string; at: string; entries: UndoEntry[] }

export type ApplyReport = {
  renamed: number
  skipped: { file: string; reason: string }[]
  undoFile: string
}

export type UndoReport = {
  /** The original names this run put back, in the order it restored them. */
  restored: string[]
  skipped: { file: string; reason: string }[]
}

/**
 * Called once per file a long rename is about to touch, so a terminal can show
 * which one it is on. A pipe never sees it: the caller's spinner swallows the
 * updates when there is no line to redraw (see `ui.spinner`).
 */
export type Progress = (done: number, total: number, file: string) => void

/** Files-only rename; throws with context when the move fails. */
function renameFile(from: string, to: string): void {
  const proc = Bun.spawnSync(['mv', '-n', from, to])
  if (proc.exitCode !== 0) {
    throw new Error(
      `renameFile: could not rename ${from} to ${to}: ${proc.stderr.toString().trim()}`
    )
  }
}

function removeFile(path: string): void {
  const proc = Bun.spawnSync(['rm', '-f', path])
  if (proc.exitCode !== 0) {
    throw new Error(`removeFile: could not delete ${path}: ${proc.stderr.toString().trim()}`)
  }
}

function undoStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

/**
 * Apply the accepted rows of `<folder>/.docnamer-plan.json`: rename each in
 * place, tag and comment it per the config, and record every change in a
 * timestamped undo file before deleting the plan. A row whose file changed size
 * or mtime since planning — or whose new name is taken — is skipped and
 * reported, never renamed.
 */
/** The plan file of `folder`, or a refusal naming the command that needed it. */
export async function readPlan(folder: string, command: string): Promise<PlanRow[]> {
  const planPath = `${folder}/${PLAN_FILE}`
  if (!(await Bun.file(planPath).exists())) {
    throw new Error(`${command}: no plan file at ${planPath} — run docnamer plan first`)
  }
  return JSON.parse(await Bun.file(planPath).text()) as PlanRow[]
}

/** Rename one accepted row and tag/OCR it, or say why it is skipped. Tagging
 *  and OCR touch independent systems, so they run concurrently. */
async function applyOne(
  folder: string,
  row: PlanRow,
  config: Config
): Promise<UndoEntry | { file: string; reason: string }> {
  const from = `${folder}/${row.old}`
  const to = `${folder}/${row.new}`
  const f = Bun.file(from)
  if (!(await f.exists())) {
    return { file: row.old, reason: 'file no longer exists' }
  }
  if (f.size !== row.size || f.lastModified !== row.mtime) {
    return { file: row.old, reason: 'file changed since planning (size or mtime differs)' }
  }
  if (await Bun.file(to).exists()) {
    return { file: row.old, reason: `target ${row.new} already exists` }
  }
  renameFile(from, to)

  const entry: UndoEntry = { old: row.old, new: row.new, size: row.size, mtime: row.mtime }
  await annotate(to, row, config, entry)
  return entry
}

/** Tag and OCR-sidecar a renamed file; the two systems are independent, so
 *  they run concurrently, and what each one did lands on the undo entry. */
async function annotate(to: string, row: PlanRow, config: Config, entry: UndoEntry): Promise<void> {
  const tagging =
    config.defaults.finder_tags && row.type !== 'other' ? setFinderTag(to, row.type) : null
  const ocrLayer =
    config.defaults.ocr_text_layer && row.method === 'ocr' ? addOcrTextLayer(to) : null
  if (tagging) {
    await tagging
    entry.tag = row.type
  }
  // Relative to the folder, like `old` and `new`, which is how undo reads it.
  if (ocrLayer) {
    await ocrLayer
    entry.sidecar = `${row.new}${SIDECAR}`
  }
}

export async function apply(
  folder: string,
  config: Config,
  progress?: Progress
): Promise<ApplyReport> {
  const planPath = `${folder}/${PLAN_FILE}`
  const rows = await readPlan(folder, 'apply')
  const accepted = rows.filter(r => r.status === 'accepted')

  const entries: UndoEntry[] = []
  const skipped: { file: string; reason: string }[] = []
  const comments: { file: string; comment: string }[] = []
  for (const [i, row] of accepted.entries()) {
    progress?.(i + 1, accepted.length, row.old)
    const result = await applyOne(folder, row, config)
    if ('reason' in result) {
      skipped.push(result)
      continue
    }
    if (config.defaults.finder_comment) {
      // Comments are batched into one osascript after the loop.
      comments.push({ file: `${folder}/${row.new}`, comment: row.summary })
    }
    entries.push(result)
  }
  await setFinderComments(comments)

  const now = new Date()
  const stamp = undoStamp(now)
  const undoFile = `.docnamer-undo-${stamp}.json`
  const record: UndoRecord = { run: stamp, at: now.toISOString(), entries }
  await Bun.write(`${folder}/${undoFile}`, JSON.stringify(record, null, 2) + '\n')
  removeFile(planPath)
  return { renamed: entries.length, skipped, undoFile }
}

/** The latest undo record file in the folder, or null. */
async function latestUndoFile(folder: string): Promise<string | null> {
  const found: string[] = []
  for await (const rel of new Bun.Glob('.docnamer-undo-*.json').scan({
    cwd: folder,
    onlyFiles: true
  })) {
    found.push(rel)
  }
  found.sort()
  // SAFE: a folder with no undo record is a legitimate state the caller reports,
  // so `?? null` only normalises `at(-1)`'s undefined into this function's
  // declared null; it does not stand in for data that should have been there.
  return found.at(-1) ?? null
}

/** Put one entry back under its original name, with its tag and without its
 *  sidecar; the refusal when it cannot be put back without overwriting. */
async function restore(
  folder: string,
  entry: UndoEntry,
  config: Config
): Promise<{ file: string; reason: string } | null> {
  const from = `${folder}/${entry.new}`
  const to = `${folder}/${entry.old}`
  if (!(await Bun.file(from).exists()))
    return { file: entry.new, reason: 'renamed file is missing' }
  if (await Bun.file(to).exists()) return { file: entry.old, reason: 'original name is occupied' }
  renameFile(from, to)
  if (entry.tag && config.defaults.finder_tags) await setFinderTag(to, entry.tag)
  // Records written before the sidecar was recorded relative hold its absolute
  // path; joined onto the folder again it named nothing, and `rm -f` of nothing
  // succeeds.
  if (entry.sidecar) {
    removeFile(entry.sidecar.startsWith('/') ? entry.sidecar : `${folder}/${entry.sidecar}`)
  }
  return null
}

/**
 * Undo a run: rename every recorded entry back to its original name, in reverse
 * order, never overwriting. `run` names the undo file; null takes the latest.
 * The undo file is deleted once restored.
 */
export async function undo(
  folder: string,
  run: string | null,
  config: Config,
  progress?: Progress
): Promise<UndoReport> {
  const name = run === null ? await latestUndoFile(folder) : run
  if (name === null) {
    throw new Error(`undo: no .docnamer-undo-*.json in ${folder} — nothing to undo`)
  }
  const path = `${folder}/${name}`
  if (!(await Bun.file(path).exists())) {
    throw new Error(`undo: undo record ${path} does not exist`)
  }
  const record = JSON.parse(await Bun.file(path).text()) as UndoRecord

  const skipped: { file: string; reason: string }[] = []
  const restored: string[] = []
  const back = [...record.entries].reverse()
  for (const [i, entry] of back.entries()) {
    progress?.(i + 1, back.length, entry.new)
    const refused = await restore(folder, entry, config)
    if (refused === null) restored.push(entry.old)
    else skipped.push(refused)
  }
  removeFile(path)
  return { restored, skipped }
}
