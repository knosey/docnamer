/**
 * E2E flow test for interaction I1 — "Apply accepted rows with backup"
 * (docs/features/doc-renamer-apply/INTERACTIONS.md).
 *
 * The digraph is entry -> check -> rename -> record -> outcome; this file is
 * those harness steps called in order, then the assertion of the Outcome:
 * `docnamer apply <folder>` renames each accepted row in place to its new name,
 * writes the type's Finder tag (and comment when enabled), records every change
 * in `<folder>/.docnamer-undo-<timestamp>.json`, deletes the plan file, and
 * skips-with-report any file whose size or mtime changed since planning.
 *
 * The harness owns booting the folder, seeding fixtures, running the CLI and
 * observing the plan, undo file and documents; this test only composes its
 * steps.
 */
import { Session, entry, check, rename, record, outcome } from "./doc-renamer-apply-harness.ts"

flow("doc-renamer-apply I1: apply accepted rows end to end", async () => {
  const s = new Session()
  await entry(s, "apply")
  await check(s)
  await rename(s)
  await record(s)
  await outcome(s, "i1-apply")
})
