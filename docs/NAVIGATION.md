# NAVIGATION

Where each part of docnamer lives. The decisions and their reasons are in `docs/adr/`; this file
only says where to look.

## The program

| Path | What is there |
| --- | --- |
| `src/cli.ts` | The entry point and every command name. The whole integration surface. |
| `src/commands.ts` | `plan`: walks a folder, runs a file through the three stages, renders a name. |
| `src/read.ts` | Stage 1, the reading ladder: text, PDF text layer, OCR, vision. |
| `src/analyse.ts` | Stage 2, the one classify-and-extract model call. |
| `src/validate.ts` | Stage 3, field normalisers and the flags a doubtful value earns. |
| `src/name.ts` | Stage 4, template rendering, sanitising, length and collision suffixes. |
| `src/config.ts` | The config loader and its types. The behaviour itself is `docnamer.json`. |
| `src/table.ts` | The plan table, flagged rows first. |
| `src/review.ts` | `review`: the screen a person walks the rows on. |
| `src/spotlight.ts` | Finder tags, Finder comments and the OCR text layer. |
| `src/eval.ts` | `eval`: scores the pipeline against a test set, renaming nothing. |
| `src/auth.ts` | Where the model credential comes from. |
| `src/device.ts` | The one place the program touches a terminal it did not inherit. |
| `src/prompt.ts` | `login`'s provider picker. |
| `src/ui.ts` | The one owner of every byte written: colour, glyphs and the ASCII fallback. |

## Behaviour you can edit without code

| Path | What is there |
| --- | --- |
| `docnamer.json` | The shipped roster: types, fields, templates, defaults, entities, self, models. Compiled into the binary, and replaced wholesale by a copy of the same name in a folder. |

## Tests

| Path | What is there |
| --- | --- |
| `tests/<feature>-harness.ts` | One exported function per step of that feature's interaction digraphs. |
| `tests/<feature>-i<n>.spec.ts` | One E2E test per interaction: the digraph's steps in order, asserting its Outcome. |
| `tests/frames.ts`, `tests/frame.ts` | Capture a rendered terminal frame for the visual and pty tests. |
| `tests/pty.ts`, `tests/child.ts` | A real pty and a real subprocess, for the tests that need one. |
| `tests/app-binary.ts` | The built binary the tests drive rather than an import. |
| `tests/fixtures/`, `tests/testset/` | Documents and images the tests read, and `eval`'s scored set. |
| `tests/holes.md` | The boundaries no test covers, each with its manual smoke. |
| Other `tests/*.test.ts` | Unit tests for pure logic a silent bug would corrupt: dates, names, config, scoring. |

## Build and gates

| Path | What is there |
| --- | --- |
| `scripts/build-app.ts` | `bun run build`: compiles the binary, codesigns it and installs it at `~/bin/docnamer`. |
| `.githooks/pre-commit` | Formats staged files, then typecheck, lint, `test:free` and the audit. |
| `bunfig.toml` | The test preload and the formatter's settings. |
| `package.json` | Every command the gates run: `check`, `lint`, `format:check`, `test:free`, `test:e2e`, `build`, `frames`, `audit`. |

## Docs

| Path | What is there |
| --- | --- |
| `docs/adr/0001-docnamer.md` | One bundled Bun CLI, native Bun, CLI-only surface, pi's model layer, nothing sticky. |
| `docs/adr/0002-doc-renamer-pipeline.md` | The reading ladder, classification, validation, naming and `plan`. |
| `docs/adr/0003-doc-renamer-apply.md` | `apply`, `undo`, the undo record, Spotlight extras, `review`, `eval`, the install step. |
| `docs/adr/0004-naming-rules.md` | Who is named, which tokens print, how long a name may be. |
| `docs/adr/0005-terminal-ux-polish.md` | The clean terminal, the review cards, the progress bar, plain wording. |
| `docs/features/<feature>/WORKPLAN.md` | The tasks a feature was built from, and what each one is checked by. |
| `docs/GLOSSARY.md` | What each word means here. |
