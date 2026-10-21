/**
 * E2E for interaction I6 — ASCII and no-colour fallback.
 *
 * Outcome: With `NO_COLOR=1` and stdout piped (not a tty), command output
 * contains no ANSI escape sequences and no `▰`, `▱` or box-drawing characters;
 * progress is shown with ASCII characters instead.
 *
 * The steps drive the real CLI: `run_with_no_color_piped` runs `docnamer plan`
 * on a pipe with `NO_COLOR=1`, so the run's stdout is the fallback channel a
 * caller redirecting to a file would get. `capture_output` writes that text as
 * the flow's evidence, and the two leaves assert the outcome — `no_ansi_escapes`
 * holds the escape-free claim, `ascii_progress_shown` holds the glyph-free,
 * ASCII-progress claim. This spec is those calls in I6's digraph order.
 */
import {
  Session,
  run_with_no_color_piped,
  capture_output,
  no_ansi_escapes,
  ascii_progress_shown
} from './terminal-ux-polish-harness.ts'

flow('terminal-ux-polish I6: ASCII and no-colour fallback', async () => {
  const s = new Session()
  await run_with_no_color_piped(s)
  await capture_output(s)
  await no_ansi_escapes(s)
  await ascii_progress_shown(s)
})
