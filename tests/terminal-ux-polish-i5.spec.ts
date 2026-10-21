/**
 * E2E for interaction I5 — Completion status uses the same block bar.
 *
 * Outcome: when analysis (or review/apply) finishes, the completion line shows
 * the full bar `▰▰▰▰▰▰▰▰▰▰ 100%` in the same format as the in-progress bars.
 *
 * The steps drive `docnamer plan <folder>` on a real pty and observe the bytes
 * it drew; this spec calls them in I5's digraph order and asserts the outcome.
 * The harness owns how each step observes the app: `analysis_completes` waits
 * for the run to exit cleanly and records its final frame, `completion_line`
 * asserts a percentage sits on that last line, and `full_bar_100_percent`
 * asserts the line carries the full ten-block bar — the same FULL_BAR format
 * the in-progress bars (I4) draw.
 *
 * An absent `docnamer` CLI is not a named hole here: I5's outcome is a real,
 * observable assertion, and with no run there is no completion line to observe.
 * The `flow` wrapper reports a `Skipped` as this flow's failure.
 */
import {
  Session,
  analysis_completes,
  completion_line,
  full_bar_100_percent,
  FULL_BAR
} from './terminal-ux-polish-harness.ts'

flow('terminal-ux-polish I5: completion status uses the same block bar', async () => {
  const s = new Session()
  await analysis_completes(s)
  await completion_line(s)
  await full_bar_100_percent(s)

  // I5's outcome, stated once more on the recorded frame: the completion line
  // ends on the full bar in the in-progress bars' format. The steps above prove
  // each half; this reads the last frame the run drew and holds the whole claim.
  const last = s.analysisFrames[s.analysisFrames.length - 1]
  if (last === undefined) {
    throw new Error('I5 outcome: analysis_completes recorded no completion frame')
  }
  if (!last.includes(FULL_BAR)) {
    throw new Error(`I5 outcome: the completion line is not the full bar ${FULL_BAR}:\n${last}`)
  }
})
