/**
 * T4 — the eval command (R8, I4).
 *
 * evalTestset() runs the same Stage 1-4 pipeline `plan` runs against every
 * graded file in a test set and scores the rows against the set's
 * expected.yaml: type accuracy, per-field exact match, full-name match, the
 * share of files that needed the vision model, and time per file. It renames,
 * moves and rewrites nothing — eval observes, it does not act — and it writes
 * no plan file: the rows live only inside the report.
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

export const EXPECTED_FILE = 'expected.yaml'

const ratio = (hits: number, total: number): number => (total === 0 ? 0 : hits / total)

export async function evalTestset(testset: string, config: Config): Promise<EvalReport> {
  const expectedPath = `${testset}/${EXPECTED_FILE}`
  if (!(await Bun.file(expectedPath).exists())) {
    throw new Error(`evalTestset: no ${EXPECTED_FILE} in ${testset} — a test set without its truth cannot be scored`)
  }
  const expected = Bun.YAML.parse(await Bun.file(expectedPath).text()) as Record<string, ExpectedEntry>
  if (expected === null || typeof expected !== 'object') {
    throw new Error(`evalTestset: ${expectedPath} did not parse to a map of file -> expectation`)
  }

  const started = performance.now()
  const rows = await plan(testset, { recursive: false, applyUnflagged: false }, config)
  const elapsedSeconds = (performance.now() - started) / 1000

  const byOld = new Map<string, PlanRow>()
  for (const row of rows) byOld.set(row.old, row)

  const files = Object.keys(expected).length
  let typeHits = 0
  let nameHits = 0
  let vision = 0
  const fieldTotals = new Map<string, { hits: number; total: number }>()
  const misses: EvalMiss[] = []

  for (const [file, exp] of Object.entries(expected)) {
    const row = byOld.get(file)
    const gotType = row?.type ?? ''
    const gotName = row?.new ?? ''
    if (row?.method === 'vision') vision++

    const typeOk = exp.type === undefined || gotType === exp.type
    const nameOk = exp.name === undefined || gotName === exp.name
    if (exp.type !== undefined && typeOk) typeHits++
    if (exp.name !== undefined && nameOk) nameHits++

    const wrongFields: string[] = []
    for (const [field, want] of Object.entries(exp.fields ?? {})) {
      const got = row?.fields[field] ?? ''
      const t = fieldTotals.get(field) ?? { hits: 0, total: 0 }
      t.total++
      if (got === want) t.hits++
      else wrongFields.push(`${field}: expected ${want}, got ${got || '(empty)'}`)
      fieldTotals.set(field, t)
    }

    if (!typeOk || !nameOk || wrongFields.length > 0) {
      const parts: string[] = []
      if (!typeOk) parts.push(`type: expected ${exp.type}, got ${gotType || '(none)'}`)
      if (!nameOk) parts.push(`name: expected ${exp.name}, got ${gotName || '(none)'}`)
      parts.push(...wrongFields)
      misses.push({
        file,
        expected: [exp.type, ...(exp.name ? [exp.name] : [])].filter(Boolean).join(' | '),
        got: [gotType, gotName].filter(Boolean).join(' | ') || '(no row)',
        evidence:
          parts.join('; ') +
          (row && Object.keys(row.evidence).length > 0
            ? ` — evidence: ${Object.entries(row.evidence)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}`
            : '')
      })
    }
  }

  const fieldMatch: Record<string, number> = {}
  for (const [field, t] of fieldTotals) fieldMatch[field] = ratio(t.hits, t.total)

  return {
    files,
    typeAccuracy: ratio(typeHits, files),
    fieldMatch,
    fullNameMatch: ratio(nameHits, files),
    visionShare: ratio(vision, files),
    secondsPerFile: files === 0 ? 0 : elapsedSeconds / files,
    // plan() does not surface per-call token usage, so a dollar figure cannot be
    // computed honestly here; the report carries the field as 0 rather than a guess.
    costPerFile: 0,
    misses
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
      lines.push(`  ${m.file}\n    expected: ${m.expected}\n    got:      ${m.got}\n    evidence: ${m.evidence}`)
    }
  } else {
    lines.push('misses: none')
  }
  return lines.join('\n')
}
