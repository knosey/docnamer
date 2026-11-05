/**
 * E2E flow test for interaction I1 — "issued contract named after the customer"
 * (docs/adr/0004-naming-rules.md).
 *
 * The digraph is entry -> step -> outcome; this file is those harness steps
 * called in order, then the assertion of the Outcome: planning
 * `20260217 - Contract - Based Platform - Crowdbuilding (draft).pdf` proposes a
 * name that contains the date, `contract`, `Crowdbuilding`, a subject, and
 * `draft`, and does not contain `Saulx`.
 *
 * The harness owns booting the folder, seeding the file and running
 * `docnamer plan`; this test only composes its steps and reads `s.names`.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

/** YYYY-MM-DD, the settled date_format; the seeded filename's date is 20260217. */
const DATE = "2026-02-17"
/** Subject token on the seeded filename, which the contract template prints. */
const SUBJECT = "Based Platform"

flow("naming-rules I1: issued contract named after the customer", async () => {
  const s = new Session("I1")
  await entry(s)
  await step(s)
  await outcome(s)

  const name = s.names[0]
  if (!name) throw new Error("I1: plan proposed no name")
  const lower = name.toLowerCase()
  if (!name.includes(DATE)) {
    throw new Error(`I1: proposed name ${name} does not contain the date ${DATE}`)
  }
  if (!lower.includes("contract")) {
    throw new Error(`I1: proposed name ${name} does not contain contract`)
  }
  if (!name.includes("Crowdbuilding")) {
    throw new Error(`I1: proposed name ${name} does not contain Crowdbuilding`)
  }
  if (!name.includes(SUBJECT)) {
    throw new Error(`I1: proposed name ${name} does not contain the subject ${SUBJECT}`)
  }
  if (!lower.includes("draft")) {
    throw new Error(`I1: proposed name ${name} does not contain draft`)
  }
  if (lower.includes("saulx")) {
    throw new Error(`I1: proposed name ${name} contains Saulx`)
  }
})
