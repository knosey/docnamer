// The reference the graph runner swaps through GRAPH_REFERENCE; assert against it, never edit it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`ls tests/fixtures`

import { scratch } from './scratch.ts'

/**
 * The shared harness of the apply/undo suites: the config, plan writer and
 * folder readers both tests/apply.test.ts and tests/apply-safety.test.ts run
 * against. `ls tests/fixtures` is the truth: the fixture documents the folder
 * is seeded with, and therefore the exact set it must hold again once `apply`
 * has renamed them and `undo` has restored them.
 */

// --- consumed shapes (structural mirrors of the interfaces T2 consumes) -----

export type Config = {
  defaults: {
    date_format: string
    date_order: 'day-first' | 'month-first'
    max_name_length: number
    ocr_text_layer: boolean
    finder_tags: boolean
    finder_comment: boolean
  }
  models: { cheap: string; vision: string; strong: string }
  types: Record<string, unknown>
  entities: Record<string, string[]>
}

type PlanRow = {
  old: string
  new: string
  type: string
  method: 'text' | 'ocr' | 'vision' | null
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

export type UndoEntry = {
  old: string
  new: string
  size: number
  mtime: number
  tag?: string
  sidecar?: string
}
export type UndoRecord = { run: string; at: string; entries: UndoEntry[] }

type ApplyReport = {
  renamed: number
  skipped: { file: string; reason: string }[]
  undoFile: string
}
type UndoReport = { restored: string[]; skipped: { file: string; reason: string }[] }

export type CommandsModule = {
  apply(folder: string, config: Config): Promise<ApplyReport>
  undo(folder: string, run: string | null, config: Config): Promise<UndoReport>
}

// --- the reference's own output: the truth this test asserts against --------

const repo = import.meta.dir.replace(/\/tests$/, '')

/** Run the reference command and return its stdout lines: the truth set. */
export function referenceOutput(): string[] {
  const argv = reference.split(/\s+/).filter(Boolean)
  if (!argv.length) throw new Error('reference is empty')
  const bin = Bun.which(argv[0]) ?? argv[0]
  const p = Bun.spawnSync([bin, ...argv.slice(1)], { cwd: repo })
  if (p.exitCode !== 0) {
    throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
  return p.stdout
    .toString()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort()
}

// --- src/commands.ts, loaded as a failed check ------------------------------

/**
 * src/commands.ts is loaded INSIDE each check with a dynamic import, never at
 * the top of the file, so a missing `apply` or `undo` export is a failed check
 * the suite reports — not a throw at load.
 */
export async function loadCommands(): Promise<CommandsModule> {
  let mod: unknown
  try {
    mod = await import('../src/commands.ts')
  } catch (e) {
    throw new Error('src/commands.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
  const c = mod as Partial<CommandsModule>
  if (typeof c.apply !== 'function') {
    throw new Error('src/commands.ts does not export apply(): the work under test is missing')
  }
  if (typeof c.undo !== 'function') {
    throw new Error('src/commands.ts does not export undo(): the work under test is missing')
  }
  return c as CommandsModule
}

// --- fixtures ---------------------------------------------------------------

export const CONFIG: Config = {
  defaults: {
    date_format: 'YYYY-MM-DD',
    date_order: 'day-first',
    max_name_length: 150,
    ocr_text_layer: false,
    finder_tags: true,
    finder_comment: false
  },
  models: { cheap: 'cheap-model', vision: 'vision-model', strong: 'strong-model' },
  types: {},
  entities: {}
}

export const PLAN = '.docnamer-plan.json'

/** A throwaway folder in /tmp (outside the tree) seeded with the fixture files,
 *  named under `prefix` when the case needs them in a subfolder. */
export async function seed(fixtures: string[], prefix = ''): Promise<string> {
  const dir = scratch('docnamer-apply')
  for (const name of fixtures) {
    const bytes = await Bun.file(`${repo}/tests/fixtures/${name}`).arrayBuffer()
    await Bun.write(prefix === '' ? `${dir}/${name}` : `${dir}/${prefix}/${name}`, bytes)
  }
  return dir
}

/** One accepted plan row per seeded fixture, with its current size and mtime.
 *  `prefix` puts the rows in a subfolder, the way a recursive plan finds them. */
export async function writeAcceptedPlan(
  dir: string,
  fixtures: string[],
  prefix = ''
): Promise<PlanRow[]> {
  const at = (name: string): string => (prefix === '' ? name : `${prefix}/${name}`)
  const rows: PlanRow[] = []
  for (const name of fixtures) {
    const f = Bun.file(`${dir}/${at(name)}`)
    rows.push({
      old: at(name),
      new: at(`renamed-${name}`),
      type: 'other',
      method: 'text',
      fields: {},
      evidence: {},
      flags: [],
      summary: name,
      size: f.size,
      mtime: f.lastModified,
      status: 'accepted'
    })
  }
  await Bun.write(`${dir}/${PLAN}`, JSON.stringify(rows, null, 2) + '\n')
  return rows
}

/** The folder's file names, sorted — the state every assertion compares. */
export async function names(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob('*').scan({ cwd: dir, onlyFiles: true })) out.push(rel)
  return out.sort()
}

export async function latestUndo(dir: string): Promise<string | null> {
  const found: string[] = []
  for await (const rel of new Bun.Glob('.docnamer-undo-*.json').scan({
    cwd: dir,
    onlyFiles: true
  })) {
    found.push(rel)
  }
  found.sort()
  return found.length ? (found[found.length - 1] ?? null) : null
}
