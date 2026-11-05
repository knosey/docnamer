/**
 * The plan table: the old→new name for every row, flagged rows first.
 *
 * A person reads this before anything is renamed, so the two columns that decide
 * are the widest, and a row needing a decision carries a `!` in its margin.
 * Every line is built by `ui.row`, so the widths, the gap and the
 * trailing-space rule live in one place; the margin goes out before any styling,
 * which is why `line.startsWith('!')` holds on a colour terminal too.
 */
import { visibleWidth } from "@earendil-works/pi-tui/dist/utils.js"
import type { PlanRow } from "./commands.ts"
import { terminalWidth, ui, type Style } from "./ui.ts"

const MARGIN = 2
const GAP = 2

/**
 * The columns that give way when the table is wider than the screen, in the
 * order they give, each down to its floor. pi-tui's SelectList is the
 * precedent: the column that names the row keeps its width and the trailing
 * description takes what is left, truncated. FLAGS is that trailing column —
 * the review card carries the flags in full — and NEW and OLD, the names being
 * decided, give way only after it. A table a row too wide for the screen wraps
 * every row onto two, and no column lines up.
 */
const GIVE: readonly (readonly [column: number, floor: number])[] = [
  [3, 10],
  [1, 24],
  [0, 16]
]

/** The column widths that fit `width`, from the widths the cells want. */
function fit(natural: readonly number[], width: number): number[] {
  const widths = [...natural]
  for (const [column, floor] of GIVE) {
    const used = MARGIN + widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1)
    const over = used - width
    if (over <= 0) break
    const w = widths[column] as number
    widths[column] = Math.max(Math.min(floor, w), w - over)
  }
  return widths
}

/** The plan table, fitted to `width` cells — the screen's, when the output is
 *  one. A pipe gets null and every cell whole, because a log has no edge. */
export function renderTable(
  rows: PlanRow[],
  style: Style,
  width: number | null = style.tty ? terminalWidth() : null
): string {
  const u = ui(style)
  const ordered = [
    ...rows.filter(r => r.flags.length > 0),
    ...rows.filter(r => r.flags.length === 0)
  ]
  const headers = ["OLD", "NEW", "TYPE", "FLAGS"]
  const natural = ordered.map(r => [r.old, r.new, r.type, r.flags.join("; ")])
  const wanted = headers.map((h, i) =>
    natural.reduce((w, c) => Math.max(w, visibleWidth(c[i] as string)), h.length)
  )
  const widths = width === null ? wanted : fit(wanted, width)
  const cells = natural.map(c => c.map((cell, i) => u.clip(cell, widths[i] as number)))
  const lines = [
    u.row("  ", headers, widths),
    u.row(
      "  ",
      widths.map(w => u.glyphs.rule.repeat(w)),
      widths
    ),
    ...cells.map((c, i) => u.row((ordered[i] as PlanRow).flags.length > 0 ? "! " : "  ", c, widths))
  ]
  // A screen narrower than every column's floor still gets rows that fit: cut
  // at its edge, after the columns have lined up.
  return (width === null ? lines : lines.map(l => u.clip(l, width))).join("\n")
}
