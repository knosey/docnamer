/**
 * THE RED CONTROL for the naming-rules harness.
 *
 * harness-smoke runs this file once, by the same `<pm> run test:e2e <file>` command a flow test is
 * run by, and refuses the run when it exits 0. A runner that exits before its flows settled reports
 * success for tests that never ran, and such a runner passes this file.
 *
 * This is a real flow through the harness: entry boots a run, then the flow holds ONE expectation
 * that is false by construction. entry() sets `s.booted = true`, so asserting the session is NOT
 * booted after entry is a claim no correct harness can satisfy. The assertion reads no CLI.
 */
import { Session, entry } from './naming-rules-harness.ts'

flow('naming-rules red control: the runner reports a failing flow', async () => {
  const s = new Session('smoke')
  await entry(s)

  // FALSE BY CONSTRUCTION: entry() set s.booted = true.
  if (s.booted) {
    throw new Error(
      "red control: entry() succeeded, so this flow's claim that the session is NOT booted is false by construction — a runner reporting it as failed is the point"
    )
  }
})
