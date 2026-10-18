// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`ls tests/fixtures`

import { expect, test } from 'bun:test'

/**
 * T2 — Apply and undo with the backup record (R2, R3, R7, I1, I2).
 * `src/commands.ts` is the work under test. It is loaded INSIDE each check with
 * a dynamic import, never at the top of the file, so a module whose `apply` or
 * `undo` export is missing is a failed check this suite reports — not an
 * uncaught throw while the file loads.
 *
 * The reference `ls tests/fixtures` is the truth: the set of fixture documents
 * the folder is seeded with, and therefore the exact set the folder must hold
 * again once `apply` has renamed them and `undo` has restored them.
 */

// --- consumed shapes (structural mirrors of the interfaces T2 consumes) -----

type Config = {
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

type ApplyReport = {
  renamed: number
  skipped: { file: string; reason: string }[]
  undoFile: string
}
type UndoReport = { restored: number; skipped: { file: string; reason: string }[] }

type CommandsModule = {
  apply(folder: string, config: Config): Promise<ApplyReport>
  undo(folder: string, run: string | null, config: Config): Promise<UndoReport>
}

// --- the reference's own output: the truth this test asserts against --------

const repo = import.meta.dir.replace(/\/tests$/, '')

/** Run the reference command and return its stdout lines: the truth set. */
function referenceOutput(): string[] {
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

async function loadCommands(): Promise<CommandsModule> {
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

const CONFIG: Config = {
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

const PLAN_FILE = '.docnamer-plan.json'

/** A throwaway folder in /tmp (outside the tree) seeded with the fixture files. */
async function seed(fixtures: string[]): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-apply-${crypto.randomUUID()}`
  Bun.spawnSync(['mkdir', '-p', dir])
  for (const name of fixtures) {
    const bytes = await Bun.file(`${repo}/tests/fixtures/${name}`).arrayBuffer()
    await Bun.write(`${dir}/${name}`, bytes)
  }
  return dir
}

/** One accepted plan row per seeded fixture, with its current size and mtime. */
async function writePlan(dir: string, fixtures: string[]): Promise<PlanRow[]> {
  const rows: PlanRow[] = []
  for (const name of fixtures) {
    const f = Bun.file(`${dir}/${name}`)
    rows.push({
      old: name,
      new: `renamed-${name}`,
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
  await Bun.write(`${dir}/${PLAN_FILE}`, JSON.stringify(rows, null, 2) + '\n')
  return rows
}

/** The folder's file names, sorted — the state every assertion compares. */
async function names(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob('*').scan({ cwd: dir, onlyFiles: true })) out.push(rel)
  return out.sort()
}

async function latestUndo(dir: string): Promise<string | null> {
  const found: string[] = []
  for await (const rel of new Bun.Glob('.docnamer-undo-*.json').scan({ cwd: dir, onlyFiles: true })) {
    found.push(rel)
  }
  found.sort()
  return found.length ? (found[found.length - 1] ?? null) : null
}

// --- cases ------------------------------------------------------------------

test('T2 apply renames every accepted row and writes the undo record', async () => {
  const c = await loadCommands()
  const fixtures = referenceOutput()
  const dir = await seed(fixtures)
  const rows = await writePlan(dir, fixtures)

  const report = await c.apply(dir, CONFIG)

  expect(report.renamed).toBe(rows.length)
  expect(report.undoFile.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect(await Bun.file(`${dir}/${r.new}`).exists()).toBe(true)
    expect(await Bun.file(`${dir}/${r.old}`).exists()).toBe(false)
  }
  // The plan is consumed: it is gone, and a timestamped undo record remains.
  expect(await Bun.file(`${dir}/${PLAN_FILE}`).exists()).toBe(false)
  const undo = await latestUndo(dir)
  expect(undo).not.toBeNull()
  expect(await Bun.file(`${dir}/${undo as string}`).exists()).toBe(true)
})

test('T2 undo restores the reference set and deletes the undo record', async () => {
  const c = await loadCommands()
  const fixtures = referenceOutput()
  const dir = await seed(fixtures)
  const rows = await writePlan(dir, fixtures)
  await c.apply(dir, CONFIG)

  const report = await c.undo(dir, null, CONFIG)

  expect(report.restored).toBe(rows.length)
  // The truth: the folder holds exactly the fixture names the reference printed.
  expect(await names(dir)).toEqual(fixtures)
  expect(await latestUndo(dir)).toBeNull()
})
