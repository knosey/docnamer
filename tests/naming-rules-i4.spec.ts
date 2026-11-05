/**
 * E2E flow test for interaction I4 — "government letter uses a short agency"
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * The digraph is entry -> step -> outcome. This file is those harness steps
 * in that order, then the assertion of the Outcome: planning
 * `Authority-Jac-EEAVISA.pdf` proposes `{date} Jac {kind} {short agency}` and
 * the name does not contain `Immigration And Naturalisation Service` or
 * `Ministry Of Justice And Security`.
 *
 * The harness owns the folder, the seed and `docnamer plan`. This test only
 * composes its steps and asserts `s.names`.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

const FULL_MINISTRY = ["Immigration And Naturalisation Service", "Ministry Of Justice And Security"]

/** `{date} Jac {kind} {short agency}.pdf` — date is YYYY-MM-DD; kind and agency are one token each. */
const SHORT_AGENCY = /^(\d{4}-\d{2}-\d{2}) Jac (\S+) (\S+)\.pdf$/

flow("naming-rules I4: government letter uses a short agency", async () => {
  const s = new Session("I4")
  await entry(s)
  await step(s)
  await outcome(s)

  if (s.names.length !== 1) {
    throw new Error(
      `I4: expected one proposed name for Authority-Jac-EEAVISA.pdf, got ${JSON.stringify(s.names)}`
    )
  }
  const name = s.names[0]?.split("/").pop() ?? ""
  for (const banned of FULL_MINISTRY) {
    if (name.includes(banned)) {
      throw new Error(
        `I4: proposed name contains the full ministry title ${JSON.stringify(banned)}: ${name}`
      )
    }
  }
  const m = SHORT_AGENCY.exec(name)
  if (!m) {
    throw new Error(
      `I4: proposed name is not {date} Jac {kind} {short agency}: ${JSON.stringify(name)}`
    )
  }
})
