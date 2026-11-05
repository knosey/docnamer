/**
 * E2E test for I2: Undo a run.
 *
 * Digraph steps in order: entry -> load -> restore -> outcome.
 *
 * Outcome: `docnamer undo <folder>` restores every file renamed by the latest
 * run to its original name (skipping and reporting any entry whose new name is
 * missing or whose old name is occupied) and deletes that undo file.
 *
 * entry boots the run, plans, accepts every row and applies — so the files are
 * renamed and a `.docnamer-undo-<timestamp>.json` exists. load reads that record,
 * restore occupies one entry's original name and runs `docnamer undo` — so the
 * run has a real skip to report — and outcome asserts the originals are back,
 * that the summary names each restored file and the skip, and that the undo file
 * is gone.
 */
import { Session, entry, load, restore, outcome } from "./doc-renamer-apply-harness.ts"

flow("doc-renamer-apply I2: undo restores every renamed file", async () => {
  const s = new Session()
  await entry(s, "undo")
  await load(s)
  await restore(s)
  await outcome(s, "i2-undo")
})
