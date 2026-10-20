# Holes — what the suite does not prove

A named hole is release debt, not permission. Each one below declares the exact
claim it does NOT prove, who owns closing it, how it would be closed
deterministically, the command a person runs by hand today, what that costs, what
makes it worth revisiting, and what it means for a release. A boundary with an
entry here is not a covered boundary; it is a hole with a name.

| # | Hole | Owner | Release impact |
| :-- | :--- | :--- | :--- |
| 1 | `mac-ocr` binary is the pinned one | operator | ships a different OCR engine silently |
| 2 | Finder tag/comment round-trip on a real folder | operator | attributes land wrong on a real Mac |
| 3 | The model's own behaviour | operator | a plan is scored against one model's answer |
| 4 | The TCC grant on `~/Downloads` | operator | the refusal path is stood in for by `chmod 000` |
| 5 | Rendered frames are evidence | operator | layout, glyph and colour regressions are invisible |
| 6 | Raw mode on the operator's own terminal | operator | the picker misbehaves on a real tty |
| 7 | The appearance layer shows no appearance | operator | `NO_COLOR=1` piped text is called visual evidence |

## 1 · `mac-ocr` is the pinned binary

- **Unproven claim:** that the `mac-ocr` a run actually resolves is the pinned
  1.2.1 build, and not whatever a global install or a stale `node_modules` holds.
- **Owner:** operator.
- **Deterministic closure:** a build-time check that reads the resolved binary's
  sha256 and fails the build on a mismatch — a first-run `bun add` hits the
  network, which no test may do.
- **Manual smoke:** `bun add mac-ocr`, then
  `shasum -a 256 node_modules/mac-ocr/bin/mac-ocr` → the pin
  `1817fff474a88706104167f8f47983ecea93a3b41cd10fa6b8585c026ffd7668`; then
  `node_modules/mac-ocr/bin/mac-ocr --version` → `1.2.1`; then
  `node_modules/mac-ocr/bin/mac-ocr tests/fixtures/acme-statement-scan.pdf --format json`
  exits 0 and prints per-page observations with confidence.
- **Cost:** one network install; seconds after that.
- **Revisit when:** `bun.lock` changes, or a read produces worse text than the
  fixture's own text layer.
- **Release impact:** a different OCR engine changes every OCR'd plan row with no
  diff in this repo to show it.

## 2 · Finder tags and comments on a real folder

- **Unproven claim:** that a tag or comment written by `apply` is the one Finder
  and Spotlight report on a folder a person actually uses.
- **Owner:** operator.
- **Deterministic closure:** none known — the read is Spotlight's index state,
  which no fixture controls.
- **Manual smoke:** plan and apply a small folder under `~/Documents`, then
  `mdls -name kMDItemUserTags -name kMDItemFinderComment <file>` and check the
  Finder's own Get Info panel agrees.
- **Cost:** a minute by hand.
- **Revisit when:** the macOS major version changes, or a report says a tag landed
  wrong.
- **Release impact:** attributes are written but land wrong; the suite stays green
  because `tests/spotlight.test.ts` reads back through the same API that wrote
  them.

## 3 · The model's own behaviour

- **Unproven claim:** that the model classifies and extracts a document the way
  the type roster intends for documents outside `tests/testset`.
- **Owner:** operator.
- **Deterministic closure:** none — the classifier is the irreducible
  externality. What IS closed: `tests/testset/expected.json` is committed truth
  written by hand, `tests/score.test.ts` pins the scoring, and
  `tests/doc-renamer-apply-harness.ts` `missTestset()` proves a miss is reported.
  A live conformance gate over a larger held-out set is the next step, and is not
  built.
- **Manual smoke:** `docnamer plan <folder>` on a folder of real documents, then
  read the plan's `type`, `fields` and `evidence` columns against the documents
  themselves.
- **Cost:** one paid call per document, measured 1.5–2.8s each; the currency cost
  is not measured in this repo.
- **Revisit when:** `src/analyse.ts`'s prompt or model id changes, or a plan
  row's `evidence` does not appear in its document.
- **Release impact:** a plan can be confidently wrong. Nothing in the suite
  contradicts it, because the suite's truth set is three files.

## 4 · The TCC grant on `~/Downloads`

- **Unproven claim:** that the real grant — the one the app bundle exists to
  obtain — is what lets `docnamer plan ~/Downloads` read the folder, and that a
  refusal outside the grant is reported as exit 2 with a named cause.
- **Owner:** operator.
- **Deterministic closure:** none; the grant is a per-machine, per-user,
  per-bundle state that only System Settings can create. What IS closed:
  `tests/pty.test.ts` and `tests/failure-report.test.ts` drive the refusal path
  with a `chmod 000` folder, which produces EACCES where macOS produces EPERM.
- **Manual smoke:** `~/bin/docnamer plan ~/Downloads` once, and confirm a plan is
  written; then run it on a folder the bundle has not been granted and confirm
  exit 2 and a message naming the folder.
- **Cost:** one prompt, once per machine.
- **Revisit when:** the bundle is rebuilt with a new signature, or macOS is
  upgraded.
- **Release impact:** `chmod 000` proves the *reporting* of a refusal, not the
  refusal itself. A machine that never granted TCC sees exit 2 where a person
  expects a plan.

## 5 · Rendered frames are evidence

- **Unproven claim:** that a frame's PNG is judged by a seat with image input and
  that a layout, glyph or colour regression fails a run.
- **Owner:** operator.
- **Deterministic closure:** `tests/frames.ts` writes the frames and exits
  non-zero unless every case produced one; the judging itself is a graph node
  (`advisor`, pinned to the vision seat by identity), which is not run by
  `bun run test:free`.
- **Manual smoke:** `bun run frames`, then open
  `.audit/screenshots/` and read each frame against the flow it names.
- **Cost:** four paid runs, one per flow — minutes.
- **Revisit when:** any change touches `src/ui.ts`, `src/prompt.ts` or the plan
  table's rendering.
- **Release impact:** `.audit/` is gitignored, so a frame never appears in a diff
  and its absence fails nothing. Text-green is the only gate the suite applies.

## 6 · Raw mode on the operator's own terminal

- **Unproven claim:** that the arrow picker's raw-mode handover and restore behave
  on a real tty — the operator's — and not only under a pty the test created.
- **Owner:** operator.
- **Deterministic closure:** partial. `tests/wrapper-pty.test.ts` drives the
  wrapper through `Bun.Terminal` and asserts the tty is restored; the operator's
  own terminal and its `TERM` are not the subject.
- **Manual smoke:** `~/bin/docnamer review <folder>`, move with the arrow keys,
  accept a row, then `Ctrl-C` and confirm the shell's echo and cursor are intact.
- **Cost:** under a minute.
- **Revisit when:** `src/prompt.ts`'s key decoder or `src/device.ts` changes.
- **Release impact:** a terminal left in raw mode is a broken shell for the person
  running it, and no automated gate would have caught it.

## 7 · The appearance layer shows no appearance

- **Unproven claim:** that what a person sees — colour, glyphs, width, cursor —
  is what the suite asserts.
- **Owner:** operator.
- **Deterministic closure:** none. `tests/frame.ts` rasterises **piped**
  `NO_COLOR=1` stdout, which is the correct artefact for its own assertion
  (`tests/cli-help.test.ts` requires zero escape sequences when colour is off)
  and the wrong artefact to call visual evidence.
- **Manual smoke:** run any of `plan`, `review`, `eval` in a terminal and read the
  output against `docs/IMPLEMENTATION.md`'s description of it.
- **Cost:** a minute.
- **Revisit when:** a frame is offered as proof of a rendered change.
- **Release impact:** the ASCII fallback and the unicode path can both be wrong
  while every test passes; hole 5 is where the rendered check belongs.
