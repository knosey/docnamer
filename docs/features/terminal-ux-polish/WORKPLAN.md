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

## T1: wrapper restores the tty and ends on a fresh line

- Covers: R1, I1
- Depends on: none
- Files:
  - Modify: [build-app.ts](../../../scripts/build-app.ts#L81-L114)
  - Test: [wrapper-pty.test.ts](../../../tests/wrapper-pty.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: none
- done_when: `bun test tests/wrapper-pty.test.ts`
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
- Reference: `plutil -p .docnamer-plan.json`
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
<!-- /record:run -->
