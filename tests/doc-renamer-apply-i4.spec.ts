/**
 * E2E for interaction I4 — Score a test set with eval.
 *
 * Outcome: `docnamer eval <testset>` runs Stages 1–4 against the test set
 * without renaming anything and prints type accuracy, per-field exact match,
 * full-name match, share of files needing vision, and time/cost per file, with
 * each miss shown as expected vs got alongside its evidence.
 *
 * The steps drive the `docnamer` CLI subprocess (decision D3) and observe its
 * stdout and the documents on disk; this spec calls them in I4's digraph order
 * and asserts the outcome. The harness owns how each step observes the app —
 * `run` proves nothing was renamed, `score` reads the metrics off the report,
 * and `outcome(s, ...)` asserts the side-by-side misses and writes the frame.
 */
import { Session, entry, run, score, outcome } from './doc-renamer-apply-harness.ts'

flow('doc-renamer-apply I4: score a test set with eval', async () => {
  const s = new Session()
  try {
    await entry(s, 'eval')
    await run(s)
    await score(s)
    await outcome(s, 'i4-eval-score')
  } catch (e) {
    // An absent `docnamer` CLI is not a named hole here: I4's outcome is a real,
    // observable assertion, and with no eval report there are no metrics or
    // misses to observe. Report it as a failure, not a green.
    if ((e as { skip?: boolean } | null)?.skip) {
      throw new Error(`I4 outcome not demonstrated: ${(e as Error).message}`)
    }
    throw e
  }
})
