/**
 * E2E for interaction I3 — Review and accept plan rows.
 *
 * Outcome: `docnamer review <folder>` presents each plan row with its old name, new name, type, flags,
 * evidence and summary; accepting, editing, re-typing or skipping a row updates its status in the plan
 * file, and "accept all unflagged" marks every flag-free row accepted while flagged rows stay pending.
 *
 * The steps drive the `docnamer` CLI only. `entry(s, 'review')` boots an isolated run, plans the folder
 * and writes every row back to the plan file as pending — the state review starts from. `act(s)` runs
 * `docnamer review <folder>` and presses "accept all unflagged" (the `A` key), then re-reads the plan
 * file so the statuses it wrote can be asserted. `outcome(s, ...)` holds the terminal claim — unflagged
 * rows accepted, flagged rows still pending — and writes the flow's frame from the review output.
 *
 * I3's digraph node `load` is not a separate export: the harness's one `load` is I2's undo-file loader,
 * and entry/act already read and re-read the plan file this flow acts on. So the calls are the
 * harness's I3 steps in order: entry -> act -> outcome.
 */
import { Session, entry, act, outcome } from './doc-renamer-apply-harness.ts'

flow('doc-renamer-apply I3: review and accept plan rows', async () => {
  const s = new Session()
  await entry(s, 'review')
  await act(s)
  await outcome(s, 'i3-review-accept')
})
