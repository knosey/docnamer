# BRIEF: doc-renamer

A standalone Bun-compiled CLI (`docnamer`) that reads each document in one folder,
classifies it against a YAML-defined set of document types, extracts that type's
fields, and renames the file in place to a consistent, Spotlight-friendly name —
only after the user reviews and approves the plan.

Full context: `docs/specs/doc-renamer.md` and
`docs/specs/doc-renamer-constraints.md`. Operator decisions D1–D3 (single bundled
binary via `bun build --compile`; native Bun APIs only, no `node:` built-ins; CLI
subprocess as the only integration surface) are settled and binding.

## Requirements

- R1: Single self-contained executable produced by `bun build --compile`; installs
  to `~/bin` (plain, not chezmoi-tracked).
- R2: Native Bun APIs only (`Bun.file`, `Bun.$`, `Bun.Glob`, `Bun.spawn`,
  `Bun.YAML`, `bun:sqlite`); no `node:` built-ins anywhere in the codebase.
- R3: All model calls (classify + extract, text and vision) go through the pi
  model provider library, imported and connected via that library — no hand-rolled
  provider HTTP layer. Cloud-first, vision-capable provider configured through it.
- R4: One YAML config file holds all behaviour: document types with plain-English
  `describe`, per-type fields with kinds (`text`, `date`, `money`, `entity`,
  `last4`), per-type name templates, defaults (`date_format`, `date_order`,
  `max_name_length`), and an entity alias map.
- R5: Ship a compiled list of the most common document types for a home and work
  computer in the YAML (superset of the spec's 14 — invoice, bank_statement,
  letter, receipt, tax_form, payslip, contract, insurance_policy, utility_bill,
  medical, warranty, id_document, certificate, manual — plus `other`, which is
  always present as the fallback).
- R6: Stage 1 read ladder, cheapest first: direct text extraction for
  txt/md/docx/xlsx/pptx/pages; PDF text layer when usable (≥200 mostly-word
  chars); otherwise page rendering (max 3 pages, 200 dpi) and OCR; vision-model
  fallback only when OCR is weak (<200 chars or mean confidence <0.6). Text
  capped at 4000 chars. iCloud placeholders downloaded first via `brctl download`.
- R7: PDF text, page rendering and OCR use Apple-native tooling where possible
  (macOS Vision via `shortcuts` for OCR, built-in tools for PDF text), per the
  brainstorm answer — except the OCR text-layer feature (R14), which uses
  `ocrmypdf` per the follow-up answer.
- R8: Stage 2: one model call per file returns type (enum), type_confidence,
  exactly that type's fields, per-field `evidence` quotes, and a ≤20-word summary
  (the Finder comment). Structured-output mode where the provider has one;
  otherwise JSON validated in code with one repair retry, then FAILED.
  Text-only calls use the cheaper model; calls with images use the vision model.
- R9: Stage 3 validation is code-side: flags for low type confidence (<0.6),
  missing required fields, evidence not fuzzy-found in extracted text,
  implausible dates (unparseable, >today+60d, <1980-01-01); money normalised to
  "amount ISO" (e.g. `482.50 GBP`); entities canonicalised via the alias map
  with legal-suffix tidying; last4 reduced to last four digits. Missing required
  fields retarget the row to `other`.
- R10: Ambiguous slashed dates are read day-first (03/04/2026 = 3 April 2026),
  driven by `date_order` in config, not guessed.
- R11: Stage 4 builds the name from the type's template: empty parts dropped
  cleanly, filesystem-unsafe characters removed, names shortened to
  `max_name_length` (cutting `subject`/`number` first), extension lowercased,
  collisions resolved with Finder-style ` (2)`, ` (3)` suffixes within both the
  folder and the current plan.
- R12: Stage 5 commands: `plan` (writes `<folder>/.docnamer-plan.json`, flagged
  rows first, `--recursive` and `--apply-unflagged` options), `review` (small TUI:
  accept / edit name / change type and re-run Stage 4 / skip / accept all
  unflagged), `apply`, `undo` (latest run or a named one, restoring in reverse).
- R13: Rename in place only — no per-type/year folder moves in v1; the `folder`
  config key is parsed but ignored. However, every apply run keeps a
  backup/restore record (`.docnamer-undo-<timestamp>.json`) so all changes can be
  undone until the user approves the result; `undo` restores original names
  (skipping/reporting rows whose size or mtime changed, and never overwriting an
  occupied old name).
- R14: OCR text layer for scanned PDFs uses `ocrmypdf --skip-text`, replacing the
  original file, so Spotlight indexes page text. Off by default; when enabled the
  rewritten file is covered by the same undo record as the rename.
- R15: Spotlight extras: Finder tag per type written directly (the `_kMDItemUserTags`
  attribute — `tag` is not installed), on by default; Finder comment (the summary)
  via Finder AppleScript, off by default.
- R16: Apply skips and reports any file whose size or mtime changed since the plan
  was written; it never renames without an accepted row.
- R17: `eval <testset>` command runs Stages 1–4 against a folder of files plus an
  `expected.yaml` and prints type accuracy, per-field exact match, full-name
  match, vision-fallback share, and time/cost per file, with misses side by side.
- R18: Nothing is renamed, moved or rewritten until the user approves plan rows;
  plan and undo files are plain JSON the user can delete; no database, no library
  of renamed files, no background process.

## Acceptance criteria

1. `bun build --compile` produces one standalone binary that runs on this machine
   with no project checkout and no `node:` imports.
2. `docnamer plan <folder>` on a folder of mixed PDFs/images writes
   `.docnamer-plan.json` with old→new names, type, fields, evidence, flags,
   size/mtime and status, and touches no original file.
3. Flagged rows (low confidence, missing required fields, unverified evidence,
   implausible dates) are presented first in both the plan output and review.
4. `docnamer apply <folder>` renames only accepted rows, writes Finder tags and
   (when enabled) comments, saves an undo file, and deletes the plan file.
5. `docnamer undo <folder>` restores original filenames from the latest undo
   record and deletes that undo file.
6. A name collision produces `name (2).pdf`, never an overwrite.
7. `docnamer eval <testset>` prints the accuracy metrics from R17.

## Out of scope

- pi extension (spec Layer 2) and SKILL.md (Layer 3) — settled by D1.
- Any published or importable library API — settled by D3.
- Folder moves by type/year — rename in place only (follow-up answer); `folder`
  config key parsed but ignored.
- Local model stack; cloud-first only via the pi provider library.
- brew-installed `tag` (attributes are written directly); `tag`-based tagging.
- Multi-folder or watch-mode/background operation; one folder per invocation.

## Approaches

- A1: Which pi model provider library is imported for model calls? — terms: pi-model-provider, structured-output
- A2: How are Finder user tags written without the tag binary? — terms: _kMDItemUserTags, xattr
- A3: How is macOS Vision OCR invoked via shortcuts? — terms: shortcuts, Vision

## Risks

- The pi model provider library's API surface may not expose structured-output
  mode or a cheap/vision model split, forcing an adapter layer (R3, R8).
- Apple-native OCR via `shortcuts` may return no usable confidence score, making
  the Stage 1 weak-OCR threshold unmeasurable (R6, R7).
- `ocrmypdf` is not installed today; the OCR text-layer feature (R14) depends on
  it being installed before use.
- Writing `_kMDItemUserTags` directly is undocumented-adjacent; Finder/Spotlight
  may not surface tags written this way (R15).
- The user may hold no API key for the cloud provider the pi library defaults to,
  blocking live classify/extract runs until configured (R3).

## Open questions resolved by interview

| Question | Answer |
| --- | --- |
| Model setup | Cloud first, vision-capable, one provider; via pi provider library |
| PDF/OCR tools | Apple-native only (Vision via `shortcuts`); except OCR layer via `ocrmypdf` |
| Date order | Day-first |
| Doc types | Compiled list of most common home/work types (superset of spec's 14 + other) |
| Install path | `~/bin` (plain) |
| Folder moves | No; backup/restore (undo) required until user approves |
| OCR text layer | Yes, via `ocrmypdf` (off by default per spec) |
