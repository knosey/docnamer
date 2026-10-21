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

## T1: the test pty keeps a screen, so I1 asserts what a person sees

R1's product half already shipped (ec5b904: the wrapper runs `stty raw -echo
opost` and restores the snapshot): the installed wrapper's version run emits
`docnamer 0.1.0\r\n`, verified byte-for-byte on a pty, and
tests/wrapper-pty.test.ts pins it green (8/8). What is missing is the
harness's ability to OBSERVE it, and the first hypothesis (answer zsh's DSR
`ESC[6n` and the marker goes away) was measured FALSE this session. The
ground truth, captured byte-for-byte on the harness pty with the DSR answer
active: after a clean CRLF zsh STILL prints `ESC[1m ESC[7m %` + resets +
spaces to the right edge + `\r \r` + resets + `ESC[J` before every prompt —
zsh's promptsp mark-then-erase is unconditional here (zsh Src/utils.c zputs
of PROMPT_EOL_MARK, probed by part-build-0). On a real screen the `\r \r`
erase overwrites the `%` at column 0 and nothing is ever visible; the marker
only SURVIVES when output stopped mid-line — the wrapper bug — where the
erase cannot reach it. So the marker is unobservable in a byte log: the
harness must keep what a terminal keeps, the screen.

This task extends the cursor tracking already in tests/pty.ts's makeTerminal
(printable bytes advance the column; CR, LF, BS and CSI H/A/B/C/D/G/d move
it; DSR answered once per query; clamp to the 100x40 box) into a screen grid:
a printable byte writes its cell then advances (clamp at the edge — the
captured erase uses CR, never wrap), CSI J clears from the cursor to the end
of the grid and CSI K to the end of the row, and Term exposes
`screen(): string` (rows up to the last non-blank, right-trimmed, joined by
newlines). Then the harness's no_stray_percent asserts on the SCREEN: the
version row stands and no `%` appears between it and the prompt; with the
fixed wrapper the screen is clean, and a wrapper regression that loses the
CR leaves `%` standing mid-line, so the test stays honest. tests/frame.ts
strips C0 control bytes (the observed backspace; keep tab and newline)
before rasterising. Build every control-byte pattern from String.fromCharCode
the way tests/pty.ts's ANSI constant does, so oxlint's no-control-regex
stays quiet. The i1 spec keeps its reference constant asserting the printed
version equals what the reference prints. 

- Covers: R1, I1
- Depends on: none
- Files:
  - Modify: [pty.ts](../../../tests/pty.ts)
  - Modify: [frame.ts](../../../tests/frame.ts)
  - Modify: [terminal-ux-polish-harness.ts](../../../tests/terminal-ux-polish-harness.ts)
  - Test: [terminal-ux-polish-i1.spec.ts](../../../tests/terminal-ux-polish-i1.spec.ts)
  - Test: [wrapper-pty.test.ts](../../../tests/wrapper-pty.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: none
- done_when: `bun run test:e2e tests/terminal-ux-polish-i1.spec.ts`
- Reference: `plutil -extract version raw package.json`
<!-- record:T1 -->
**hole** · run `ship-feature-47c841`
- Commits: none — HEAD stayed at `3d6e3f5`
- Landed: [tests/frame.ts](../../../tests/frame.ts), [tests/pty.test.ts](../../../tests/pty.test.ts), [tests/pty.ts](../../../tests/pty.ts), [tests/review-screen.test.ts](../../../tests/review-screen.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✗
- Tests: task-test#0 done
- Summary: done_when — exit 1 — output tail: … [+19 earlier line(s)] 0 pass 1 fail Ran 1 test across 1 file. [407.00ms] error: script "test:e2e" exited with code 1 files named: tests/terminal-ux-polish-i1.spec.ts
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
**done** · run `ship-feature-47c841`
- Commits: none — HEAD stayed at `3d6e3f5`
- Landed: [src/ui.ts](../../../src/ui.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✓ · reference_decides ✓
- Tests: task-test#1 done
- Summary: T2 built: added `progressBar(done, total, style)` to src/ui.ts plus `full`/`empty` glyphs (`▰`/`▱` unicode, `#`/`-` ASCII); `bun test tests/ui.test.ts` green (14 pass, 0 fail), and sibling tests/progress-bar.test.ts also fully green (5 pass, including T3 wiring).
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
**done** · run `ship-feature-47c841`
- Commits: none recorded
- Landed: nothing
- Gates: done_when ✓ · reference_decides ✓
- Tests: task-test#2 done
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/progress-bar.test.ts` passes as committed — the task shipped in an earlier run: src/cli.ts, src/commands.ts
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
**hole** · run `ship-feature-47c841`
- Commits: none — HEAD stayed at `3d6e3f5`
- Landed: [src/review.ts](../../../src/review.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✓ · reference_decides ✗
- Tests: task-test#3 done
- Summary: reference_decides — `bun test tests/review-screen.test.ts` passed with its reference swapped for a wrong truth — the test's verdict does not depend on its reference; that is the test's defect, not this build's: … [+5 earlier line(s)] 2 pass 0 fail 30 expect() calls Ran 2 tests across 1 file. [273.00ms]
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
- Reference: `printf '%s\n' '2024-03-13 globex receipt.pdf'`
<!-- record:T5 -->
**hole** · run `ship-feature-47c841`
- Commits: none — HEAD stayed at `3d6e3f5`
- Landed: [src/review.ts](../../../src/review.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✗
- Tests: task-test#4 done
- Summary: done_when — exit 1 — output tail: … [+27 earlier line(s)] 6 pass 1 fail 28 expect() calls Ran 7 tests across 1 file. [1.97s] files named: tests/pty.test.ts
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
**done** · run `ship-feature-47c841`
- Commits: none recorded
- Landed: nothing
- Gates: done_when ✓ · reference_decides ✓
- Tests: task-test#5 done
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/cli-help.test.ts` passes as committed — the task shipped in an earlier run: src/cli.ts, src/prompt.ts, src/validate.ts
<!-- /record:T6 -->

<!-- record:run -->
**failed** · run `ship-feature-47c841`
- Tasks: T1 hole · T2 done · T3 done · T4 hole · T5 hole · T6 done
- Commits: none — HEAD stayed at `3d6e3f5`
- Detail: verify: exit 1 — output tail: … [+21662 earlier chars] the block bar follows the locale charmap [2.94ms] (pass) a completed run draws the full ten-block bar [0.14ms] (pass) a half-finished run fills half the bar [0.06ms] (pass) an ASCII terminal gets an ASCII bar with no block glyph [0.06ms] tests/failure-report.test.ts: (pass) a folder that cannot be read is named, with a way forward [88.66ms] te… [+3832 chars]
<!-- /record:run -->
