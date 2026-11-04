/**
 * The eval command.
 *
 * evalTestset() runs the same Stage 1-4 pipeline `plan` runs against every graded
 * file in a test set and scores the rows against the set's expected.json: type
 * accuracy, per-field exact match, full-name match, the share of files that
 * needed the vision model, and time per file. It renames, moves and rewrites
 * nothing, and it writes no plan file: the rows live only inside the report.
 */
import { plan, type PlanRow } from './commands.ts'
import type { Config } from './config.ts'

export type EvalMiss = { file: string; expected: string; got: string; evidence: string }

export type EvalReport = {
  files: number
  typeAccuracy: number
  fieldMatch: Record<string, number>
  fullNameMatch: number
  visionShare: number
  secondsPerFile: number
  costPerFile: number
  misses: EvalMiss[]
}

type ExpectedEntry = {
  type?: string
  fields?: Record<string, string>
  name?: string
}

export const EXPECTED_FILE = 'expected.json'

const ratio = (hits: number, total: number): number => (total === 0 ? 0 : hits / total)

export async function evalTestset(testset: string, config: Config): Promise<EvalReport> {
  const expectedPath = `${testset}/${EXPECTED_FILE}`
  if (!(await Bun.file(expectedPath).exists())) {
    throw new Error(
      `evalTestset: no ${EXPECTED_FILE} in ${testset} — a test set without its truth cannot be scored`
    )
  }
  const expected = JSON.parse(await Bun.file(expectedPath).text()) as Record<string, ExpectedEntry>
  if (expected === null || typeof expected !== 'object') {
    throw new Error(`evalTestset: ${expectedPath} did not parse to a map of file -> expectation`)
  }

  const started = performance.now()
  const rows = await plan(testset, { recursive: false, applyUnflagged: false }, config)
  return scorePlan(expected, rows, (performance.now() - started) / 1000)
}

/** The counters one entry moves. */
type Tally = {
  typeHits: number
  typed: number
  nameHits: number
  named: number
  vision: number
  fieldTotals: Map<string, { hits: number; total: number }>
  misses: EvalMiss[]
}

/** The `type` and `name` hit counts, moved only where the truth declares them:
 *  a set that leaves `type` out of one entry must not score that entry as a
 *  type miss against the whole set. */
function countNames(
  exp: ExpectedEntry,
  got: { type: string; name: string },
  tally: Tally
): { typeOk: boolean; nameOk: boolean } {
  const typeOk = exp.type === undefined || got.type === exp.type
  const nameOk = exp.name === undefined || got.name === exp.name
  if (exp.type !== undefined) {
    tally.typed++
    if (typeOk) tally.typeHits++
  }
  if (exp.name !== undefined) {
    tally.named++
    if (nameOk) tally.nameHits++
  }
  return { typeOk, nameOk }
}

/** Every declared field, exact: hits counted, misses worded for the report. */
function countFields(
  exp: ExpectedEntry,
  // SAFE: a miss is a measurement, not a failure — "the plan has no row for this
  // file" is one of the outcomes this file exists to record.
  row: PlanRow | undefined,
  tally: Tally
): string[] {
  const wrong: string[] = []
  for (const [field, want] of Object.entries(exp.fields ?? {})) {
    const got = row?.fields[field] ?? ''
    // SAFE: a Map accumulator — the first sighting of a field starts at zero.
    const t = tally.fieldTotals.get(field) ?? { hits: 0, total: 0 }
    t.total++
    if (got === want) t.hits++
    else wrong.push(`${field}: expected ${want}, got ${got || '(empty)'}`)
    tally.fieldTotals.set(field, t)
  }
  return wrong
}

/** The parts of an entry that did not match, worded as the report prints them. */
function wrongParts(
  exp: ExpectedEntry,
  got: { type: string; name: string },
  ok: { typeOk: boolean; nameOk: boolean },
  wrongFields: string[]
): string[] {
  const parts: string[] = []
  if (!ok.typeOk) parts.push(`type: expected ${exp.type}, got ${got.type || '(none)'}`)
  if (!ok.nameOk) parts.push(`name: expected ${exp.name}, got ${got.name || '(none)'}`)
  parts.push(...wrongFields)
  return parts
}

/** The truth's own words for one entry, and what the row actually says, as the
 *  report prints them. */
function expectedText(exp: ExpectedEntry): string {
  return exp.name === undefined
    ? (exp.type ?? '')
    : [exp.type, exp.name].filter(Boolean).join(' | ')
}

function gotText(row: PlanRow | undefined): string {
  const parts = [row?.type ?? '', row?.new ?? ''].filter(Boolean)
  return parts.length === 0 ? '(no row)' : parts.join(' | ')
}

function evidenceText(row: PlanRow | undefined): string {
  const found = Object.entries(row?.evidence ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  return found === '' ? '' : ` — evidence: ${found}`
}

/** One miss, with the evidence the row was judged on. */
function missOf(
  file: string,
  exp: ExpectedEntry,
  row: PlanRow | undefined,
  parts: string[]
): EvalMiss {
  return {
    file,
    expected: expectedText(exp),
    got: gotText(row),
    evidence: parts.join('; ') + evidenceText(row)
  }
}

/** What a row says for the parts the truth may declare. */
function gotOf(row: PlanRow | undefined): { type: string; name: string; vision: boolean } {
  return {
    type: row?.type ?? '',
    name: row?.new ?? '',
    vision: row?.method === 'vision'
  }
}

/** Grade one file's truth against its row. */
function scoreEntry(
  file: string,
  exp: ExpectedEntry,
  row: PlanRow | undefined,
  tally: Tally
): void {
  const { vision, ...got } = gotOf(row)
  if (vision) tally.vision++
  const ok = countNames(exp, got, tally)
  const wrongFields = countFields(exp, row, tally)
  if (ok.typeOk && ok.nameOk && wrongFields.length === 0) return
  tally.misses.push(missOf(file, exp, row, wrongParts(exp, got, ok, wrongFields)))
}

/** Grade a plan's rows against the set's truth. Every ratio counts only what the
 *  truth declares for that part, so a set that leaves `type` out of one entry
 *  cannot score that entry as a type miss against the whole set. */
export function scorePlan(
  expected: Record<string, ExpectedEntry>,
  rows: PlanRow[],
  elapsedSeconds: number
): EvalReport {
  const byOld = new Map<string, PlanRow>()
  for (const row of rows) byOld.set(row.old, row)

  const files = Object.keys(expected).length
  const tally: Tally = {
    typeHits: 0,
    typed: 0,
    nameHits: 0,
    named: 0,
    vision: 0,
    fieldTotals: new Map(),
    misses: []
  }
  for (const [file, exp] of Object.entries(expected)) scoreEntry(file, exp, byOld.get(file), tally)

  const fieldMatch: Record<string, number> = {}
  for (const [field, t] of tally.fieldTotals) fieldMatch[field] = ratio(t.hits, t.total)

  return {
    files,
    typeAccuracy: ratio(tally.typeHits, tally.typed),
    fieldMatch,
    fullNameMatch: ratio(tally.nameHits, tally.named),
    visionShare: ratio(tally.vision, files),
    secondsPerFile: files === 0 ? 0 : elapsedSeconds / files,
    // plan() does not surface per-call token usage, so a dollar figure cannot be
    // computed honestly; the report carries the field as 0 rather than a guess.
    costPerFile: 0,
    misses: tally.misses
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

export function formatEvalReport(r: EvalReport): string {
  const lines: string[] = [
    `eval report: ${r.files} file(s)`,
    `type accuracy:   ${pct(r.typeAccuracy)}`,
    `full name match: ${pct(r.fullNameMatch)}`,
    `vision share:    ${pct(r.visionShare)}`,
    `time per file:   ${r.secondsPerFile.toFixed(2)}s`,
    `cost per file:   $${r.costPerFile.toFixed(4)}`,
    `field exact match:`
  ]
  for (const [field, v] of Object.entries(r.fieldMatch)) lines.push(`  ${field}: ${pct(v)}`)
  if (r.misses.length > 0) {
    lines.push(`misses (${r.misses.length}):`)
    for (const m of r.misses) {
      lines.push(
        `  ${m.file}\n    expected: ${m.expected}\n    got:      ${m.got}\n    evidence: ${m.evidence}`
      )
    }
  } else {
    lines.push('misses: none')
  }
  return lines.join('\n')
}
