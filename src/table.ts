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
 * This is a column layout, not a second layout engine: every line is built by
 * `ui.row`, so the widths, the gap and the trailing-space rule live in one
 * place. The `!` is that row's MARGIN, emitted before any styling, which is why
 * `line.startsWith('!')` holds on a colour terminal too.
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
