/**
 * E2E flow test for interaction I6 — "screenshot of a document keeps that type"
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * The digraph is entry -> step -> outcome. This file is those harness calls
 * in that order, then the assertion of the Outcome: planning a screenshot
 * whose page is a readable invoice proposes an invoice name from the invoice
 * template (`{date} {issuer} invoice {number}`), not a photo title and not
 * type `other`.
 *
 * The harness owns the folder, the seed and `docnamer plan`. This test only
 * composes the steps and reads the plan the outcome step observed.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

flow("naming-rules I6: screenshot of a document keeps that type", async () => {
  const s = new Session("I6")
  await entry(s)
  await step(s)
  await outcome(s)

  if (s.plan.length !== 1) {
    throw new Error(`I6: expected one plan row for the screenshot, got ${s.plan.length}`)
  }
  const row = s.plan[0]
  if (row.type !== "invoice") {
    throw new Error(
      `I6: screenshot of a readable invoice was typed ${row.type}, not invoice (a photo title or type other both fail this)`
    )
  }
  const file = row.new.split("/").pop() ?? row.new
  if (!file.endsWith(".png")) {
    throw new Error(`I6: proposed name ${row.new} dropped the screenshot extension`)
  }
  const base = file.slice(0, -".png".length)
  const parts = base.split(" ").filter(p => p.length > 0)
  const date = parts[0] ?? ""
  const [y, m, d, extra] = date.split("-")
  const invoiceAt = parts.indexOf("invoice")
  if (
    !y ||
    y.length !== 4 ||
    !m ||
    m.length !== 2 ||
    !d ||
    d.length !== 2 ||
    extra !== undefined ||
    invoiceAt < 2 ||
    invoiceAt !== parts.length - 2
  ) {
    throw new Error(
      `I6: proposed name ${row.new} is not the invoice template {date} {issuer} invoice {number} — a photo title does not have that shape`
    )
  }
})
