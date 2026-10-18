// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`ls tests/fixtures`

import { expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'
import { ensureProviderKey } from './preload.ts'

/**
 * T4 — the eval command and the scored test set (R8, I4).
 *
 * `src/eval.ts` is the work under test. It is loaded INSIDE each check with a
 * dynamic import, never at the top of the file, so a module whose `evalTestset`
 * or `formatEvalReport` export is missing is a failed check this suite reports —
 * not an uncaught throw while the file loads.
 *
 * The reference `ls tests/fixtures` is the truth: the set of graded documents
 * `tests/testset/` is seeded with, and therefore the exact set `evalTestset`
 * must score. Nothing is renamed: eval observes, it does not act.
 */

// --- consumed shapes (structural mirrors of the interfaces T4 consumes) ------

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

type EvalMiss = { file: string; expected: string; got: string; evidence: string }
type EvalReport = {
  files: number
  typeAccuracy: number
  fieldMatch: Record<string, number>
  fullNameMatch: number
  visionShare: number
  secondsPerFile: number
  costPerFile: number
  misses: EvalMiss[]
}

type EvalModule = {
  evalTestset(testset: string, config: Config): Promise<EvalReport>
  formatEvalReport(r: EvalReport): string
}
type CliModule = { main(argv: string[]): Promise<number> }

// --- the reference's own output: the truth this test asserts against --------

const repo = import.meta.dir.replace(/\/tests$/, '')
const TESTSET = `${repo}/tests/testset`
const EXPECTED = `${TESTSET}/expected.yaml`

/** Run the reference command and return its stdout lines, sorted: the truth set. */
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

/** The graded files in `tests/testset/` — everything but `expected.yaml`. */
async function gradedFiles(): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const rel of new Bun.Glob('*').scan({ cwd: TESTSET, onlyFiles: true })) {
      if (rel === 'expected.yaml') continue
      out.push(rel)
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    throw e
  }
  return out.sort()
}

// --- src/eval.ts, loaded as a failed check -----------------------------------

async function loadEval(): Promise<EvalModule> {
  let mod: unknown
  try {
    mod = await import('../src/eval.ts')
  } catch (e) {
    throw new Error('src/eval.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
  const m = mod as Partial<EvalModule>
  if (typeof m.evalTestset !== 'function') {
    throw new Error('src/eval.ts does not export evalTestset(): the work under test is missing')
  }
  if (typeof m.formatEvalReport !== 'function') {
    throw new Error(
      'src/eval.ts does not export formatEvalReport(): the work under test is missing'
    )
  }
  return m as EvalModule
}

async function loadCli(): Promise<CliModule> {
  let mod: unknown
  try {
    mod = await import('../src/cli.ts')
  } catch (e) {
    throw new Error('src/cli.ts is not loadable: ' + ((e as Error)?.message ?? String(e)))
  }
  const m = mod as Partial<CliModule>
  if (typeof m.main !== 'function') throw new Error('src/cli.ts does not export main()')
  return m as CliModule
}

const config: Config = loadConfig(`${repo}/docnamer.json`)

// --- cases -------------------------------------------------------------------

test('eval.ts exports its T4 surface', async () => {
  const mod = await loadEval()
  expect(typeof mod.evalTestset).toBe('function')
  expect(typeof mod.formatEvalReport).toBe('function')
})

test('the graded test set is the reference set, plus expected.yaml', async () => {
  const names: string[] = []
  try {
    for await (const rel of new Bun.Glob('*').scan({ cwd: TESTSET, onlyFiles: true }))
      names.push(rel)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
  expect(names).toContain('expected.yaml')
  expect(await Bun.file(EXPECTED).exists()).toBe(true)
  // The truth: the graded files are exactly what the reference printed.
  expect(await gradedFiles()).toEqual(referenceOutput())
})

test('evalTestset scores the graded set without renaming anything', async () => {
  const mod = await loadEval()
  await ensureProviderKey()
  const before = await gradedFiles()

  const report = await mod.evalTestset(TESTSET, config)

  // The truth: the report covers exactly the reference file set.
  expect(report.files).toBe(referenceOutput().length)
  expect(typeof report.typeAccuracy).toBe('number')
  expect(report.typeAccuracy).toBeGreaterThanOrEqual(0)
  expect(report.typeAccuracy).toBeLessThanOrEqual(1)
  expect(typeof report.fieldMatch).toBe('object')
  for (const v of Object.values(report.fieldMatch)) {
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  }
  expect(report.fullNameMatch).toBeGreaterThanOrEqual(0)
  expect(report.fullNameMatch).toBeLessThanOrEqual(1)
  expect(report.visionShare).toBeGreaterThanOrEqual(0)
  expect(report.visionShare).toBeLessThanOrEqual(1)
  expect(typeof report.secondsPerFile).toBe('number')
  expect(report.secondsPerFile).toBeGreaterThan(0)
  expect(typeof report.costPerFile).toBe('number')
  expect(Array.isArray(report.misses)).toBe(true)
  for (const miss of report.misses) {
    expect(typeof miss.file).toBe('string')
    expect(typeof miss.expected).toBe('string')
    expect(typeof miss.got).toBe('string')
    expect(typeof miss.evidence).toBe('string')
  }

  // eval observes: the graded set is unchanged on disk.
  expect(await gradedFiles()).toEqual(before)
}, 300000)

test('formatEvalReport renders the metrics and the expected-vs-got misses', async () => {
  const mod = await loadEval()
  const report: EvalReport = {
    files: 2,
    typeAccuracy: 0.5,
    fieldMatch: { date: 1, vendor: 0.5 },
    fullNameMatch: 0.5,
    visionShare: 0.25,
    secondsPerFile: 1.5,
    costPerFile: 0.002,
    misses: [
      { file: 'receipt.png', expected: 'receipt', got: 'other', evidence: 'vision read the total' }
    ]
  }
  const text = mod.formatEvalReport(report)
  for (const metric of ['type', 'field', 'full', 'vision', 'cost']) {
    expect(text.toLowerCase()).toContain(metric)
  }
  expect(text).toContain('receipt.png')
  expect(text).toContain('expected')
  expect(text).toContain('got')
  expect(text).toContain('vision read the total')
})

test('cli.ts dispatches eval against a test set and prints the report', async () => {
  const cli = await loadCli()
  const before = await gradedFiles()
  const code = await cli.main(['eval', TESTSET])
  expect(code).toBe(0)
  // Nothing renamed: the graded set is still there, exactly as before.
  expect(await gradedFiles()).toEqual(before)
}, 300000)
