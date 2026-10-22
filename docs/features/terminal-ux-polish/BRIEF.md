# BRIEF: terminal-ux-polish

Terminal UX polish pass for docnamer: usable by a 10-year-old, as nice as an
Ink app (without using Ink). Four work items from the operator: (1) the stray
`%` zsh prints after `docnamer --version`, caused by the wrapper's raw-mode
tty losing the trailing CRLF; (2) a redesigned review screen focused on the
document, with padding between documents and controls always visible as a
locked header; (3) block progress bars (`▰▰▰▰▱▱▱▱▱▱ 45%`) next to the
throbber during analysis and for completion status; (4) plainer wording
across user-visible strings.

## Requirements

- R1: Running `docnamer --version` (and every other non-interactive command)
  must leave the terminal in a clean state: output ends with a newline, no
  stray `%` from zsh, no residual raw mode. The wrapper must restore the tty
  before exiting.
- R2: The review screen shows several documents at once as visually padded
  cards in a scrollable list, with the document content (proposed name,
  evidence quotes) as the visual focus of each card. (User decision: stacked
  padded cards, option 2.)
- R3: Review controls (accept / edit / skip / quit, plus position like
  `3/12`) are always visible in a locked header that does not scroll away.
- R4: The user can revisit and change any already-assessed document: after
  completing documents 1–10, the user can go back to document 3 and change
  its name (e.g. when document 11 clashes with it), then return to the
  remaining work.
- R5: During document analysis, a block progress bar in the form
  `▰▰▰▰▱▱▱▱▱▱ 45%` renders next to the existing throbber and updates as
  documents complete.
- R6: The same block-bar style reports completion status (e.g. review or
  apply progress) wherever a fraction-complete is already known.
- R7: User-visible strings — prompts, errors, help text — are rewritten in
  plain English a 10-year-old can read. Command names and flag names are
  unchanged.
- R8: Unicode (`▰▱`, box drawing) and colour are used when the terminal
  supports them, with automatic fallback to plain ASCII and no colour when
  `TERM`/`NO_COLOR`/non-tty output says otherwise.

## Acceptance criteria

- AC1 (R1): `docnamer --version` under zsh in a real pty prints the version
  followed by a normal shell prompt on the next line; no `%` marker appears.
- AC2 (R2, R3): A rendered review frame (headless pty capture) shows more
  than one document card, visible padding between cards, and the controls
  header present regardless of scroll position.
- AC3 (R4): In an automated pty run, the user accepts document 1, navigates
  back to it, changes the name, and the plan on disk reflects the change.
- AC4 (R5, R6): Analysis output frames contain a `▰`/`▱` bar followed by a
  percentage that increases monotonically; completion status shows the same
  bar format.
- AC5 (R7): Help text and every prompt/error string pass a plain-language
  review; no command or flag name changes (existing CLI tests still pass
  unmodified on names).
- AC6 (R8): With `NO_COLOR=1` and a non-tty pipe, output contains no ANSI
  escapes and no `▰`/`▱`/box-drawing characters; ASCII equivalents appear
  instead.

## Components touched

- `scripts/` wrapper (raw-mode tty restore, CRLF handling) — R1
- `src/review.ts` — review screen layout, cards, locked header, revisit — R2–R4
- `src/ui.ts` — progress bar renderer, capability detection, fallback — R5, R6, R8
- `src/analyse.ts`, `src/commands.ts`, `src/cli.ts`, `src/prompt.ts`,
  `src/table.ts` — throbber/bar wiring and plain-language strings — R5–R7
- `src/validate.ts`, `src/eval.ts` — user-visible error/help strings — R7

## Out of scope

- Renaming commands or flags, or adding aliases (user decision: strings only).
- Using Ink or any new TUI framework.
- Changing what the analysis pipeline extracts or how names are proposed.
- Behaviour of the eval command beyond wording of its user-visible output.

## Risks

- The wrapper's raw-mode lifecycle may be shared with interactive commands;
  fixing `--version` must not break the review screen's key handling.
- ASCII fallback paths double the rendering code paths; a bug there only
  shows on non-unicode terminals.
- Revisit-and-change invalidates clash checks already run on later
  documents; the re-check on re-entry must be defined or clashes can slip
  through.

## Approaches

- A1: How should the wrapper restore the tty and guarantee a trailing newline for non-interactive commands? — terms: rawmode, CRLF
- A2: Which capability-detection rule gates unicode/colour output? — terms: NO_COLOR, isTTY

## Decisions

<!-- record:decisions -->
- brainstorm · run `brainstorm-design-9b4e5a` · asked: Review screen: with controls locked as a header, how should each document be laid out — one document filling the viewport (scroll between docs), or several padded cards stacked in a list? — answered: in the operator's words: 2 and I want to be able to reselect and version already assessed and change, for example I complete the first 10 and a the… [+95 chars]
- brainstorm · run `brainstorm-design-9b4e5a` · asked: Plainer wording: how far should it go — only user-visible strings (prompts, errors, help), or also command names and flags? — answered: Strings only, names unchanged (Recommended)
- brainstorm · run `brainstorm-design-9b4e5a` · asked: How much may the UI depend on terminal features — is plain ANSI colour/box-drawing on any modern terminal enough, or must everything degrade gracefully to plain ASCII (no unicode ▰▱, no colour)? — answered: Unicode+colour with ASCII fallback (Recommended)
- plan · run `ship-feature-18a5f1` · asked: After the user goes back and changes an already-assessed document's name (R4), when should name-clash checks against later documents re-run? The BRIEF lists this as an open risk and the workplan's T5 does not define it. — answered: Re-check on edit, block clashing save (Recommended)
<!-- /record:decisions -->
