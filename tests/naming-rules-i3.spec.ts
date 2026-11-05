/**
 * E2E flow test for interaction I3 — "passport named in English with the holder"
 * (docs/adr/0004-naming-rules.md).
 *
 * The digraph is entry -> step -> outcome; this file is those harness steps
 * called in order, then the assertion of the Outcome: planning
 * `passport-jacqui-with-stamps.pdf` proposes a name of the form
 * `{date} Jacqui passport` plus the extension, and the name does not contain
 * `REISEPASS`.
 *
 * The harness owns booting the folder, seeding the file and running
 * `docnamer plan`; this test only composes its steps and asserts `s.names`.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

/** date_format is YYYY-MM-DD (docs/adr/0004-naming-rules.md, out of scope to change). */
const PASSPORT = /^\d{4}-\d{2}-\d{2} Jacqui passport\.pdf$/

flow("naming-rules I3: passport named in English with the holder", async () => {
  const s = new Session("I3")
  await entry(s)
  await step(s)
  await outcome(s)

  const name = s.names[0] ?? ""
  const base = name.split("/").pop() ?? name
  if (s.names.length !== 1 || !PASSPORT.test(base) || base.includes("REISEPASS")) {
    throw new Error(
      `I3: planning passport-jacqui-with-stamps.pdf must propose "{date} Jacqui passport.pdf" and must not contain REISEPASS, got ${JSON.stringify(s.names)}`
    )
  }
})
