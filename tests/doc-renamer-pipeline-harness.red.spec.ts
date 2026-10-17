/**
 * THE RED CONTROL for the doc-renamer-pipeline harness.
 *
 * `harness-smoke` runs this file once, by the same `<pm> run test:e2e <file>`
 * command a flow test is run by, and refuses the run when it exits 0. The smoke
 * proves the runner can pass; this proves it can fail. A runner that exits
 * before its flows settled reports success for tests that never ran — run
 * ship-feature-f3bae4's four specs each exited 0 with nothing run, and all three
 * flow-test children came back "GREEN BEFORE THE BUILD" — and such a runner
 * passes this file, so harness-smoke refuses it there, before any flow test is
 * paid for.
 *
 * The assertion below is false by construction and reads no CLI, so this fails
 * before the build as well as after it.
 *
 * It keeps its `.spec.ts` name because harness-smoke reaches it by path, and bun
 * only treats an argument as a path when it matches a test-file glob — a `.red.ts`
 * name would be read as a name filter and match nothing. `bun test` alone would
 * therefore run it and be red forever, so the whole-suite script carries
 * `--path-ignore-patterns='**\/*.red.spec.ts'`, while `test:e2e` carries no
 * ignore, which is how this file still fails when it is the file named.
 */
import { Session } from './doc-renamer-pipeline-harness.ts'

flow('doc-renamer-pipeline red control: the runner reports a failing flow', async () => {
  const s = new Session()
  // FALSE BY CONSTRUCTION: a Session boots on demand and is born un-booted, so
  // this flow must fail, and a runner that reports it passes this control.
  if (s.booted === false) {
    throw new Error(
      "red control: a fresh Session is un-booted, so this flow's claim is false and the runner must report it failed"
    )
  }
})
