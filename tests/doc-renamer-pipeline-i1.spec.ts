/**
 * E2E flow test for interaction I1 — "Plan a folder of documents without
 * touching files" (docs/adr/0002-doc-renamer-pipeline.md).
 *
 * The digraph is entry -> read -> analyse -> name -> outcome; this file is
 * those harness steps called in order, then the assertion of the Outcome:
 * `docnamer plan <folder>` writes `<folder>/.docnamer-plan.json` with a pending
 * row per file and leaves every original's name, size and mtime unchanged.
 *
 * The harness owns booting the folder, seeding fixtures, running the CLI and
 * observing the plan; this test only composes its steps.
 */
import { Session, entry, read, analyse, name, outcome } from "./doc-renamer-pipeline-harness.ts"

flow("doc-renamer-pipeline I1: plan a folder end to end", async () => {
  const s = new Session()
  await entry(s)
  await read(s)
  await analyse(s)
  await name(s)
  await outcome(s, "i1-plan-table")
})
