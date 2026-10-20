/**
 * The plan table: the old→new name for every row, flagged rows first.
 *
 * A person reads this before anything is renamed, so the two columns that decide
 * are the widest, and a row needing a decision carries a `!` in its margin.
 * Every line is built by `ui.row`, so the widths, the gap and the
 * trailing-space rule live in one place; the margin goes out before any styling,
 * which is why `line.startsWith('!')` holds on a colour terminal too.
 */
import type { PlanRow } from './commands.ts'
import { ui, type Style } from './ui.ts'

export function renderTable(rows: PlanRow[], style: Style): string {
  const u = ui(style)
  const ordered = [
    ...rows.filter(r => r.flags.length > 0),
    ...rows.filter(r => r.flags.length === 0)
  ]
  const headers = ['OLD', 'NEW', 'TYPE', 'FLAGS']
  const cells = ordered.map(r => [r.old, r.new, r.type, r.flags.join('; ')])
  const widths = headers.map((h, i) =>
    cells.reduce((w, c) => Math.max(w, (c[i] as string).length), h.length)
  )
  return [
    u.row('  ', headers, widths),
    u.row(
      '  ',
      widths.map(w => u.glyphs.rule.repeat(w)),
      widths
    ),
    ...cells.map((c, i) => u.row((ordered[i] as PlanRow).flags.length > 0 ? '! ' : '  ', c, widths))
  ].join('\n')
}
