/**
 * The plan table on a screen fits the screen; on a pipe it is whole. A table
 * row one cell too wide wraps onto two and no column lines up, so on a screen
 * the trailing FLAGS column gives way first, with an ellipsis — pi-tui's
 * SelectList precedent — and the names being decided keep their width. These
 * are the rows the i5 frame showed cut to `missing requ4` at 100 columns.
 */
import { expect, test } from "bun:test"
import { visibleWidth } from "@earendil-works/pi-tui/dist/utils.js"
import type { PlanRow } from "../src/commands.ts"
import { renderTable } from "../src/table.ts"

const style = { colour: false, unicode: true, tty: true }

const row = (old: string, name: string, type: string, flags: string[]): PlanRow => ({
  old,
  new: name,
  type,
  method: "text",
  fields: {},
  evidence: {},
  flags,
  summary: "",
  size: 1,
  mtime: 0,
  status: "pending"
})

const rows = [
  row("acme-statement-scan.pdf", "2024-03-12 Acme Services statement.pdf", "bank_statement", [
    "missing required field last4"
  ]),
  row("statement-text.pdf", "2024-03-12 Acme Services statement (2).pdf", "bank_statement", [
    "missing required field last4"
  ]),
  row("dup-invoice.txt", "2024-02-04 Globex invoice GLX-0091.txt", "invoice", []),
  row("receipt.png", "2024-03-12 Acme Services receipt.png", "receipt", [])
]

test("at 100 columns every line fits, the names stay whole and FLAGS gives way with an ellipsis", () => {
  const lines = renderTable(rows, style, 100).split("\n")
  for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(100)
  const text = lines.join("\n")
  for (const r of rows) {
    expect(text).toContain(r.old)
    expect(text).toContain(r.new)
  }
  const flagged = lines.filter(l => l.startsWith("!"))
  expect(flagged.length).toBe(2)
  for (const line of flagged) expect(line.trimEnd().endsWith("\u2026")).toBe(true)
})

test("at 60 columns the names give way too, after FLAGS, and every line still fits", () => {
  for (const line of renderTable(rows, style, 60).split("\n")) {
    expect(visibleWidth(line), line).toBeLessThanOrEqual(60)
  }
})

test("a pipe gets every cell whole, because a log has no edge", () => {
  const text = renderTable(rows, { ...style, tty: false })
  expect(text).toContain("missing required field last4")
  expect(text).not.toContain("\u2026")
})

test("colour off writes no escape, even where a cell is cut", () => {
  const text = renderTable(rows, { colour: false, unicode: true, tty: true }, 100)
  expect(text).not.toContain(String.fromCharCode(27))
})
