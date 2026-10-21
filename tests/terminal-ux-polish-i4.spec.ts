/**
 * E2E flow test for interaction I4 — "block progress bar next to the throbber
 * during analysis" (docs/features/terminal-ux-polish/INTERACTIONS.md).
 *
 * The digraph is start_analysis -> throbber_with_bar -> capture_frames ->
 * percentage_increases; this file is those harness steps called in order, then
 * the assertion of the Outcome: captured frames of the analysis phase show a
 * `▰`/`▱` block bar followed by a percentage beside the throbber, and the
 * percentage increases monotonically as documents complete.
 *
 * The harness owns driving `docnamer plan` on a real pty, waiting on the
 * throbber, capturing each distinct frame and writing the last one to
 * `.audit/screenshots/`; its steps assert the outcome (a bar with a percentage,
 * then percentages that never fall) as they run. This test only composes them.
 */
import {
  Session,
  start_analysis,
  throbber_with_bar,
  capture_frames,
  percentage_increases
} from './terminal-ux-polish-harness.ts'

flow('terminal-ux-polish I4: block progress bar next to the throbber during analysis', async () => {
  const s = new Session()
  await start_analysis(s)
  await throbber_with_bar(s)
  await capture_frames(s)
  await percentage_increases(s)
})
