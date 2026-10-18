/**
 * Stage 4 plan command (R9, R10, R11).
 *
 * plan() walks a folder, runs each document through Stage 1 read, Stage 2
 * analyse and Stage 3 validate, then renders a unique new name with Stage 4.
 * It renames, moves and rewrites nothing (R11): its only output is the row
 * set, and writePlan() persists that set as plain JSON in
 * `<folder>/.docnamer-plan.json`.
 */
import { analyse, isFailed, type Analysis } from './analyse.ts'
import type { Config } from './config.ts'
import { buildName } from './name.ts'
import { read, pageImages } from './read.ts'
import { setFinderTag, setFinderComment, addOcrTextLayer } from './spotlight.ts'
import { validate, type Checked } from './validate.ts'

export type PlanRow = {
  old: string
  new: string
  type: string
  /**
   * Which rung of Stage 1's ladder produced the content Stage 2 classified
   * (I2): a usable text layer, OCR above the confidence threshold, or the
   * vision model when OCR came back weak. Null when the read itself failed.
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

const PLAN_FILE = '.docnamer-plan.json'

function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function extOf(p: string): string {
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
    out.push(rel)
  }
  out.sort()
  return out
}

export async function plan(
  folder: string,
  opts: { recursive: boolean; applyUnflagged: boolean },
  config: Config
): Promise<PlanRow[]> {
  const rels = await scan(folder, opts.recursive)
  const planned = new Set<string>()
  // Names already on disk are occupied too: no row may propose one (I3).
  for (const rel of rels) planned.add(base(rel).toLowerCase())

  // Stages 1-3 are independent per file — one model call each (R6) — so they
  // run concurrently; Stage 4 below is serial because it mutates `planned`.
  const examined = await Promise.all(
    rels.map(async rel => {
      const path = `${folder}/${rel}`
      const old = base(rel)
      try {
        const content = await read(path)
        // Stage 1 SKIPped the file (unsupported type): it is not a document, so
        // it gets no row at all. The folder's own docnamer.yaml is the case in
        // point — a row for it would propose its own name back at it and collide.
        if (content === null) return null
        const result: Analysis | { failed: true; reason: string } = await analyse(
          content,
          old,
          config
        )
        if (!isFailed(result as never)) {
          return { rel, old, checked: validate(result as Analysis, content, config), failedReason: null as string | null, method: content.method as PlanRow['method'] }
        }
        // A reply the tool contract could not read is the one case worth a
        // second, stronger look: hand the first page's image to the strong seat
        // and take whatever name it returns (R4, I2).
        const images = pageImages(path)
        const retry: Analysis | { failed: true; reason: string } =
          images.length === 0
            ? result
            : await analyse({ ...content, images, method: 'vision' }, old, config, 'strong')
        if (!isFailed(retry as never)) {
          return { rel, old, checked: validate(retry as Analysis, content, config), failedReason: null, method: content.method as PlanRow['method'] }
        }
        const checked: Checked = {
          type: 'other',
          type_confidence: 0,
          fields: {},
          summary: stemOf(old),
          flags: []
        }
        return { rel, old, checked, failedReason: (retry as { reason: string }).reason, method: content.method as PlanRow['method'] }
      } catch (e) {
        const checked: Checked = {
          type: 'other',
          type_confidence: 0,
          fields: {},
          summary: stemOf(old),
          flags: []
        }
        return { rel, old, checked, failedReason: (e as Error)?.message ?? String(e), method: null as PlanRow['method'] }
      }
    })
  )

  const rows: PlanRow[] = []
  for (const ex of examined) {
    if (ex === null) continue
    const { rel, old, checked, failedReason, method } = ex
    const fields: Record<string, string> = {}
    const evidence: Record<string, string> = {}
    for (const [k, v] of Object.entries(checked.fields)) {
      fields[k] = v.value ?? ''
      evidence[k] = v.evidence ?? ''
    }
    const flags = [...checked.flags]
    if (failedReason !== null) flags.push(`analysis failed: ${failedReason}`)

    // EVERY row goes through Stage 4, a failed one included. A row that kept
    // its own name would propose a name already on disk by definition, and I3
    // forbids that. buildName seeds `planned` with every name on disk, so the
    // failed row lands on the stem plus a Finder-style " (2)" (I3).
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

/** Persist the plan as plain JSON in the folder (R11). */
export async function writePlan(folder: string, rows: PlanRow[]): Promise<void> {
  await Bun.write(`${folder}/${PLAN_FILE}`, JSON.stringify(rows, null, 2) + '\n')
}

// --- Stage 5: apply and undo (R2, R3, R7, I1, I2) ------------------------------

export type UndoEntry = {
  old: string
  new: string
  size: number
  mtime: number
  tag?: string
  comment?: string
  sidecar?: string
}

export type UndoRecord = { run: string; at: string; entries: UndoEntry[] }

export type ApplyReport = {
  renamed: number
  skipped: { file: string; reason: string }[]
  undoFile: string
}

export type UndoReport = {
  restored: number
  skipped: { file: string; reason: string }[]
}

/** Files-only rename; throws with context when the move fails. */
function renameFile(from: string, to: string): void {
  const proc = Bun.spawnSync(['mv', '-n', from, to])
  if (proc.exitCode !== 0) {
    throw new Error(`renameFile: could not rename ${from} to ${to}: ${proc.stderr.toString().trim()}`)
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
 * timestamped undo file before deleting the plan (R2, R3, I1). A row whose
 * file changed size or mtime since planning — or whose new name is taken — is
 * skipped and reported, never renamed (R7).
 */
export async function apply(folder: string, config: Config): Promise<ApplyReport> {
  const planPath = `${folder}/${PLAN_FILE}`
  if (!(await Bun.file(planPath).exists())) {
    throw new Error(`apply: no plan file at ${planPath} — run docnamer plan first`)
  }
  const rows = JSON.parse(await Bun.file(planPath).text()) as PlanRow[]

  const entries: UndoEntry[] = []
  const skipped: { file: string; reason: string }[] = []
  for (const row of rows) {
    if (row.status !== 'accepted') continue
    const from = `${folder}/${row.old}`
    const to = `${folder}/${row.new}`
    const f = Bun.file(from)
    if (!(await f.exists())) {
      skipped.push({ file: row.old, reason: 'file no longer exists' })
      continue
    }
    if (f.size !== row.size || f.lastModified !== row.mtime) {
      skipped.push({ file: row.old, reason: 'file changed since planning (size or mtime differs)' })
      continue
    }
    if (await Bun.file(to).exists()) {
      skipped.push({ file: row.old, reason: `target ${row.new} already exists` })
      continue
    }
    renameFile(from, to)

    const entry: UndoEntry = { old: row.old, new: row.new, size: row.size, mtime: row.mtime }
    if (config.defaults.finder_tags && row.type !== 'other') {
      await setFinderTag(to, row.type)
      entry.tag = row.type
    }
    if (config.defaults.finder_comment) {
      await setFinderComment(to, row.summary)
      entry.comment = row.summary
    }
    if (config.defaults.ocr_text_layer && row.method === 'ocr') {
      entry.sidecar = (await addOcrTextLayer(to)).sidecar
    }
    entries.push(entry)
  }

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
  for await (const rel of new Bun.Glob('.docnamer-undo-*.json').scan({ cwd: folder, onlyFiles: true })) {
    found.push(rel)
  }
  found.sort()
  return found.length ? (found[found.length - 1] ?? null) : null
}

/**
 * Undo a run: rename every recorded entry back to its original name, in
 * reverse order, never overwriting (R3, I2). `run` names the undo file;
 * null takes the latest. The undo file is deleted once restored.
 */
export async function undo(
  folder: string,
  run: string | null,
  config: Config
): Promise<UndoReport> {
  const name = run ?? (await latestUndoFile(folder))
  if (name === null) {
    throw new Error(`undo: no .docnamer-undo-*.json in ${folder} — nothing to undo`)
  }
  const path = `${folder}/${name}`
  if (!(await Bun.file(path).exists())) {
    throw new Error(`undo: undo record ${path} does not exist`)
  }
  const record = JSON.parse(await Bun.file(path).text()) as UndoRecord

  const skipped: { file: string; reason: string }[] = []
  let restored = 0
  for (const entry of [...record.entries].reverse()) {
    const from = `${folder}/${entry.new}`
    const to = `${folder}/${entry.old}`
    if (!(await Bun.file(from).exists())) {
      skipped.push({ file: entry.new, reason: 'renamed file is missing' })
      continue
    }
    if (await Bun.file(to).exists()) {
      skipped.push({ file: entry.old, reason: 'original name is occupied' })
      continue
    }
    renameFile(from, to)
    if (entry.tag && config.defaults.finder_tags) await setFinderTag(to, entry.tag)
    if (entry.sidecar) removeFile(`${folder}/${entry.sidecar}`)
    restored++
  }
  removeFile(path)
  return { restored, skipped }
}
