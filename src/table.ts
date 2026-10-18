/**
 * The plan table (I1's Outcome: "prints the old→new table with flagged rows
 * first").
 *
 * A person reads this before anything is renamed, so the two columns that
 * decide are the widest: what the file is called now and what it will be called.
 * Rows needing a decision are printed first and carry a `!` in the margin —
 * the reader's eye lands on what needs them, not on the rows that are already
 * fine.
 *
 * Plain text, no escapes: the output is piped and diffed, and a column width is
 * computed from the content so nothing is ever truncated. The frame the visual
 * review reads is this exact string (tests/frame.ts).
 */
import type { PlanRow } from './commands.ts'

function width(values: string[], min: number): number {
  let w = min
  for (const v of values) if (v.length > w) w = v.length
  return w
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(n > s.length ? n - s.length : 0)
}

export function renderTable(rows: PlanRow[]): string {
  const flagged = rows.filter(r => r.flags.length > 0)
  const clean = rows.filter(r => r.flags.length === 0)
  const ordered = [...flagged, ...clean]

  const oldW = width(
    ordered.map(r => r.old),
    3
  )
  const newW = width(
    ordered.map(r => r.new),
    3
  )
  const typeW = width(
    ordered.map(r => r.type),
    4
  )

  const out = [
    `  ${pad('OLD', oldW)}  ${pad('NEW', newW)}  ${pad('TYPE', typeW)}  FLAGS`,
    `  ${'-'.repeat(oldW)}  ${'-'.repeat(newW)}  ${'-'.repeat(typeW)}  -----`
  ]
  for (const r of ordered) {
    const mark = r.flags.length > 0 ? '!' : ' '
    const line = `${mark} ${pad(r.old, oldW)}  ${pad(r.new, newW)}  ${pad(r.type, typeW)}  ${r.flags.join('; ')}`
    out.push(line.trimEnd())
  }
  return out.join('\n')
}
