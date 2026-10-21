/**
 * E2E flow test for interaction I1 — "version command leaves a clean terminal"
 * (docs/features/terminal-ux-polish/INTERACTIONS.md).
 *
 * The digraph is run_version -> capture_pty_frame -> {no_stray_percent,
 * prompt_on_own_line}; this file is those harness steps called in order, then
 * the assertion of the Outcome: `docnamer --version` run under zsh in a real
 * pty prints the version line and the shell prompt returns on the next line
 * with no stray `%` marker and the tty back in cooked mode.
 *
 * The harness owns driving the wrapper on a pty and capturing the frame; this
 * test only composes its steps.
 */
import {
  Session,
  run_version,
  capture_pty_frame,
  no_stray_percent,
  prompt_on_own_line
} from './terminal-ux-polish-harness.ts'

flow('terminal-ux-polish I1: version command leaves a clean terminal', async () => {
  const s = new Session()
  await run_version(s)
  await capture_pty_frame(s)
  await no_stray_percent(s)
  await prompt_on_own_line(s)
})
