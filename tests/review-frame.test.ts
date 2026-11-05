/**
 * The review screen's frame, held to pi-tui's component contract with no pty in
 * the way: every line fits the width, the frame fits the height, and the header
 * — title with the position, then the keys — leads every frame, so it cannot
 * scroll away when the cards below it change. Styled output, because the width
 * that matters is the cells a person sees, not the escape sequences.
 */
import { expect, test } from "bun:test"
import { visibleWidth } from "@earendil-works/pi-tui/dist/utils.js"
import type { PlanRow } from "../src/commands.ts"
import { reviewFrame, type ReviewView } from "../src/review.ts"
import { ui } from "../src/ui.ts"
import { ANSI } from "./pty.ts"

const u = ui({ colour: true, unicode: true, tty: true })

const row = (old: string, over: Partial<PlanRow> = {}): PlanRow => ({
  old,
  new: `2024-03-12 ${old}`,
  type: "receipt",
  method: "text",
  fields: {},
  evidence: { date: "Date 12 March 2024" },
  flags: [],
  summary: `A receipt named ${old}.`,
  size: 1,
  mtime: 0,
  status: "pending",
  ...over
})

const view = (rows: PlanRow[], over: Partial<ReviewView> = {}): ReviewView => ({
  rows,
  order: rows.map((_, i) => i),
  cursor: 0,
  planPath: "/var/folders/z8/pztf_rjx3y55l7hhjw7krf280000gn/T/docnamer-ux-4785/.docnamer-plan.json",
  edit: null,
  note: null,
  ...over
})

const plain = (lines: string[]): string[] => lines.map(l => l.replace(ANSI, ""))

const many = Array.from({ length: 44 }, (_, i) => row(`scan-${String(i + 1).padStart(4, "0")}.pdf`))

for (const [width, height] of [
  [80, 23],
  [100, 39],
  [60, 11]
] as const) {
  test(`at ${width}x${height} every line fits and the frame fits the screen`, () => {
    for (const cursor of [0, 1, 20, 43, 44]) {
      const lines = reviewFrame(view(many, { cursor }), width, height, u)
      expect(lines.length).toBeLessThanOrEqual(height)
      for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width)
    }
  })

  test(`at ${width}x${height} the header leads every frame, wherever the cursor is`, () => {
    for (const cursor of [0, 20, 43]) {
      const lines = plain(reviewFrame(view(many, { cursor }), width, height, u))
      expect(lines[0]).toContain(`Reviewing document ${cursor + 1} of 44`)
      expect(lines.slice(0, 5).join("\n")).toMatch(/keys:.*accept/s)
      expect(lines.slice(0, 5).join("\n")).toContain("q quit")
    }
  })
}

test("the card under the cursor comes first, pointed at, and the next is padded apart from it", () => {
  const rows = [row("a.pdf"), row("b.pdf"), row("c.pdf")]
  const lines = plain(reviewFrame(view(rows, { cursor: 1 }), 100, 39, u))
  const cards = lines.flatMap((l, i) => (/\[\d+\/3\]/.test(l) ? [i] : []))
  expect(cards.length).toBe(2)
  expect(lines[cards[0] as number]).toMatch(/^❯ \[2\/3\] b\.pdf/)
  expect(lines[cards[1] as number]).toMatch(/^ {2}\[3\/3\] c\.pdf/)
  expect(lines[(cards[1] as number) - 1]).toBe("")
  expect(lines.join("\n")).not.toContain("a.pdf")
})

test("a decided row says so, so moving back to it shows what was decided", () => {
  const rows = [row("a.pdf", { status: "accepted" }), row("b.pdf")]
  const lines = plain(reviewFrame(view(rows), 100, 39, u))
  expect(lines.find(l => l.includes("[1/2]"))).toContain("(accepted)")
})

test("the edit line stands in place of the row it edits", () => {
  const rows = [row("a.pdf"), row("b.pdf")]
  const edit = {
    field: "new" as const,
    render: (w: number) => `      new name: typed so far`.slice(0, w)
  }
  const lines = plain(reviewFrame(view(rows, { edit }), 100, 39, u))
  const at = lines.findIndex(l => l.includes("[1/2]"))
  expect(lines[at + 1]).toContain("new name: typed so far")
  expect(lines.slice(at, at + 5).join("\n")).not.toContain("new:  2024-03-12 a.pdf")
})

test("an edit line drawn at its given width fits without being cut", () => {
  const rows = [row("a.pdf")]
  const edit = { field: "new" as const, render: (w: number) => `    new name: x`.padEnd(w) }
  const lines = plain(reviewFrame(view(rows, { edit }), 80, 23, u))
  const line = lines.find(l => l.includes("new name:")) as string
  expect(visibleWidth(line)).toBe(80)
  expect(line.endsWith("...")).toBe(false)
})

test("a name wider than the screen ends in an ellipsis instead of wrapping", () => {
  const rows = [row("a.pdf", { new: `2024-03-12 ${"very long name ".repeat(10)}.pdf` })]
  const lines = plain(reviewFrame(view(rows), 80, 23, u))
  const named = lines.find(l => l.includes("new:"))
  expect(named?.endsWith("\u2026")).toBe(true)
})

test("every document decided says so and keeps the way back on screen", () => {
  const rows = [row("a.pdf", { status: "accepted" })]
  const lines = plain(reviewFrame(view(rows, { cursor: 1 }), 100, 39, u))
  expect(lines[0]).toContain("Reviewed all 1 documents")
  expect(lines.join("\n")).toContain("every document has a decision")
})
