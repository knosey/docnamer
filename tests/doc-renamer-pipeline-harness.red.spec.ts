/**
 * THE RED CONTROL for the doc-renamer-pipeline harness.
 *
 * `harness-smoke` runs this file once, by the same `<pm> run test:e2e <file>` command a flow test is
 * run by, and refuses the run when it exits 0: the smoke proves the runner can pass, this proves it
 * can fail. A runner that exits before its flows settled reports success for tests that never ran,
 * and such a runner passes this file.
 *
 * This is a real flow through the harness: it boots a run exactly as
 * `doc-renamer-pipeline-harness.smoke.spec.ts` does, then holds ONE expectation that is false by
 * construction. boot() sets `s.booted = true` on success, so asserting the session is NOT booted
 * after a successful boot is a claim no correct harness can satisfy. The assertion reads no CLI, so
 * this fails before the docnamer CLI is built as well as after it.
 *
 * It keeps its `.spec.ts` name because harness-smoke reaches it by path, and bun only treats an
 * argument as a path when it matches a test-file glob — a `.red.ts` name would be read as a name
 * filter and match nothing. `bun test` alone would therefore run it and be red forever, so the
 * whole-suite script carries `--path-ignore-patterns='**\/*.red.spec.ts'`, while `test:e2e` carries
 * no ignore, which is how this file still fails when it is the file named.
 */
import { Session, boot } from "./doc-renamer-pipeline-harness.ts"

flow("doc-renamer-pipeline red control: the runner reports a failing flow", async () => {
  const s = new Session()
  await boot(s)

  // FALSE BY CONSTRUCTION: boot() set s.booted = true, so this flow's claim is
  // false and the runner must report it failed. A runner that reports it passed
  // is a runner harness-smoke must refuse.
  if (s.booted) {
    throw new Error(
      "red control: boot() succeeded, so this flow's claim that the session is NOT booted is false by construction — a runner reporting it as failed is the point"
    )
  }
})
