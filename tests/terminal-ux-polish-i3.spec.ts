/**
 * E2E flow test for interaction I3 — "revisit and change an already-assessed
 * document" (docs/adr/0005-terminal-ux-polish.md).
 *
 * The digraph is accept_doc1 -> navigate_back -> edit_name ->
 * plan_updated_for_doc1 -> later_docs_unchanged; this file is those harness
 * steps called in order, then the assertion of the Outcome: the user accepts
 * document 1 of several, navigates back to it, edits its proposed name, and the
 * plan file on disk records the new name for that document while later
 * documents keep their prior state.
 *
 * The harness owns booting the isolated run, driving `docnamer review` on a pty
 * and reading the plan it wrote; the last two steps hold the Outcome — the plan
 * on disk carries the edited name and status for document 1 and the later rows
 * are untouched — so this test only composes its steps.
 */
import {
  Session,
  accept_doc1,
  navigate_back,
  edit_name,
  plan_updated_for_doc1,
  later_docs_unchanged
} from "./terminal-ux-polish-harness.ts"

flow("terminal-ux-polish I3: revisit and change an already-assessed document", async () => {
  const s = new Session()
  await accept_doc1(s)
  await navigate_back(s)
  await edit_name(s)
  await plan_updated_for_doc1(s)
  await later_docs_unchanged(s)
})
