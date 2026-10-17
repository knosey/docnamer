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
import { read } from './read.ts'
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

function flatten(checked: Checked): {
  fields: Record<string, string>
  evidence: Record<string, string>
} {
  const fields: Record<string, string> = {}
  const evidence: Record<string, string> = {}
  for (const [k, v] of Object.entries(checked.fields)) {
    fields[k] = v.value ?? ''
    evidence[k] = v.evidence ?? ''
  }
  return { fields, evidence }
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
  const rows: PlanRow[] = []
  const planned = new Set<string>()
  // Names already on disk are occupied too: no row may propose one (I3).
  for (const rel of await scan(folder, opts.recursive)) {
    planned.add(base(rel).toLowerCase())
  }

  for (const rel of await scan(folder, opts.recursive)) {
    const path = `${folder}/${rel}`
    const f = Bun.file(path)
    const old = base(rel)

    let checked: Checked
    let failedReason: string | null = null
    let method: PlanRow['method'] = null
    try {
      const content = await read(path)
      // Stage 1 SKIPped the file (unsupported type): it is not a document, so it
      // gets no row at all. The folder's own docnamer.yaml is the case in point —
      // a row for it would propose its own name back at it and collide.
      if (content === null) continue
      method = content.method
      const result: Analysis | { failed: true; reason: string } = await analyse(
        content,
        old,
        config
      )
      if (isFailed(result as never)) {
        failedReason = (result as { reason: string }).reason
        checked = { type: 'other', type_confidence: 0, fields: {}, summary: old, flags: [] }
      } else {
        checked = validate(result as Analysis, content, config)
      }
    } catch (e) {
      failedReason = (e as Error)?.message ?? String(e)
      checked = { type: 'other', type_confidence: 0, fields: {}, summary: old, flags: [] }
    }

    const { fields, evidence } = flatten(checked)
    const flags = [...checked.flags]
    let name: string
    if (failedReason !== null) {
      flags.push(`analysis failed: ${failedReason}`)
      // Without an analysis there is nothing to render; the row keeps the
      // original name so the plan is a faithful no-op for this document.
      name = old
    } else {
      name = await buildName(checked, config, { dir: folder, ext: extOf(old) }, planned)
    }

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
