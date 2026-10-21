# WORKPLAN: terminal-ux-polish

## Global Constraints

- Command names and flag names are unchanged (user decision: strings only).
- Using Ink or any new TUI framework is out of scope; pi-tui is the reference.
- Capability gate stays `styleFrom(env, tty)` in src/ui.ts: colour requires
  `tty && !('NO_COLOR' in env) && env.TERM !== 'dumb'`; unicode requires
  `env.TERM !== 'dumb' && utf8(env)`.
- The wrapper keeps raw input with cooked output (`stty raw -echo opost`) and
  restores the snapshotted tty (`stty "$SAVED"`) before exiting.
- Changing what the analysis pipeline extracts or how names are proposed is
  out of scope.

## Setup

- `true`

## T1: the test pty answers zsh's cursor query, so I1 sees what a real terminal sees

R1's product half already shipped (ec5b904: the wrapper runs `stty raw -echo
opost` and restores the snapshot): the installed wrapper's version run emits
`docnamer 0.1.0\r\n`, verified byte-for-byte on a pty, and
tests/wrapper-pty.test.ts pins it green (8/8). What is missing is the
harness's ability to OBSERVE it, measured this session: zsh prints its
inverse `%` partial-line marker after EVERY command on a Bun.Terminal pty —
a plain `printf 'hi there\n'` gets it — because zsh's promptsp logic asks
the terminal where the cursor is (`ESC[6n`, DSR) and nothing answers, and the
capture's bare backspace byte is invalid XML 1.0, so sips refuses the raster
("Cannot extract image from file") and I1's frame step crashes.

This task teaches tests/pty.ts's makeTerminal to track the cursor the way a
real terminal emulator does (printable bytes advance the column; CR, LF, BS
and the CSI H/A/B/C/D/G/d sequences move it; clamp to the 100x40 box) and to
answer each DSR query once by writing `ESC[{row};{col}R` to the terminal's
input. Then the fixed wrapper's CRLF leaves the cursor at column 1, zsh
prints no `%`, and the flow is green for the operator's reason; a wrapper
regression that loses the CR leaves the column mid-line and the marker
returns, so the test stays honest. tests/frame.ts strips C0 control bytes
(the observed backspace; keep tab and newline) before rasterising. Build both
patterns from String.fromCharCode the way tests/pty.ts's ANSI constant does,
so oxlint's no-control-regex stays quiet. The i1 spec gains the reference
constant and asserts the printed version equals what the reference prints.

- Covers: R1, I1
- Depends on: none
- Files:
  - Modify: [pty.ts](../../../tests/pty.ts)
  - Modify: [frame.ts](../../../tests/frame.ts)
  - Test: [terminal-ux-polish-i1.spec.ts](../../../tests/terminal-ux-polish-i1.spec.ts)
  - Test: [wrapper-pty.test.ts](../../../tests/wrapper-pty.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: none
- done_when: `bun run test:e2e tests/terminal-ux-polish-i1.spec.ts`
- Reference: `plutil -extract version raw package.json`
<!-- record:T1 -->
<!-- /record:T1 -->

## T2: block progress bar renderer with ASCII fallback

- Covers: R8, I6
- Depends on: none
- Files:
  - Modify: [ui.ts](../../../src/ui.ts#L36-L83)
  - Test: [ui.test.ts](../../../tests/ui.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: `progressBar(done: number, total: number, style: Style): string`; `Glyphs.full: string`; `Glyphs.empty: string`
- done_when: `bun test tests/ui.test.ts`
- Reference: `locale charmap`
<!-- record:T2 -->
<!-- /record:T2 -->

## T3: progress bar wired next to the throbber and into completion lines

- Covers: R5, R6, I4, I5
- Depends on: T2
- Files:
  - Modify: [cli.ts](../../../src/cli.ts#L420-L455)
  - Modify: [commands.ts](../../../src/commands.ts#L197-L246)
  - Test: [progress-bar.test.ts](../../../tests/progress-bar.test.ts)
- Interfaces:
  - Consumes: `progressBar(done: number, total: number, style: Style): string`; `Ui.spinner(label: string): Spinner`; `Progress = (done: number, total: number, file: string) => void`
  - Produces: none
- done_when: `bun test tests/progress-bar.test.ts`
- Reference: `locale charmap`
<!-- record:T3 -->
<!-- /record:T3 -->

## T4: review screen renders stacked padded cards with a locked controls header

- Covers: R2, R3, I2
- Depends on: none
- Files:
  - Modify: [review.ts](../../../src/review.ts#L97-L166)
  - Test: [review-screen.test.ts](../../../tests/review-screen.test.ts)
- Interfaces:
  - Consumes: `visibleWidth(s: string): number`; `matchesKey(key: string, pattern: string): boolean`; `Ui`
  - Produces: none
- done_when: `bun test tests/review-screen.test.ts`
- Reference: `tput cols`
<!-- record:T4 -->
<!-- /record:T4 -->

## T5: revisit and re-edit any already-assessed document

- Covers: R4, I3
- Depends on: T4
- Files:
  - Modify: [review.ts](../../../src/review.ts#L117-L152)
  - Test: [pty.test.ts](../../../tests/pty.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: none
- done_when: `bun test tests/pty.test.ts`
- Reference: `grep -o '2024-03-13 globex receipt.pdf' tests/terminal-ux-polish-harness.ts`
<!-- record:T5 -->
<!-- /record:T5 -->

## T6: plain-English wording across help, prompts and errors

- Covers: R7
- Depends on: T3
- Files:
  - Modify: [cli.ts](../../../src/cli.ts#L40-L160)
  - Modify: [prompt.ts](../../../src/prompt.ts)
  - Modify: [validate.ts](../../../src/validate.ts)
  - Test: [cli-help.test.ts](../../../tests/cli-help.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: none
- done_when: `bun test tests/cli-help.test.ts`
- Reference: `plutil -extract version raw package.json`
<!-- record:T6 -->
<!-- /record:T6 -->

<!-- record:run -->
**failed** · run `ship-feature-ace690`
- Tasks: T1 not started · T2 not started · T3 not started · T4 not started · T5 not started · T6 not started
- Commits: none recorded
- Detail: task-tests: fan-out child 'task-test#4 (T5: revisit and re-edit any already-assessed document)' failed: reference — the truth this step asserts is not obtainable before any work: ## What the reference prints now `plutil -p .docnamer-plan.json` exited 1: ``` .docnamer-plan.json: (The file “.docnamer-plan.json” couldn’t be opened because there is no such file.) ``` — and landed nothing, so it is not… [+341 chars]
<!-- /record:run -->
