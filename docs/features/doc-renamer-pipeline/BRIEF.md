# BRIEF: doc-renamer-pipeline

The first half of `docnamer`: a standalone Bun-compiled CLI that reads each document
in one folder, classifies it against a YAML-defined set of document types, extracts
that type's fields, validates them in code, and writes a plan file of old→new names —
touching no original file.

This feature ends at a working `docnamer plan <folder>`. The second half —
`apply`, `undo`, the review TUI, Spotlight extras, `eval` and the compile/install
step — is `doc-renamer-apply`, which depends on this one.

Full context: `docs/specs/doc-renamer.md` and
`docs/specs/doc-renamer-constraints.md`. Operator decisions D1–D4 (single bundled
binary via `bun build --compile`; native Bun APIs only, no `node:` built-ins; CLI
subprocess as the only integration surface; all model calls through
`@earendil-works/pi-ai` v1.3.0) are settled and binding.

## Requirements

- R1: One YAML config file holds all behaviour: document types with plain-English
  `describe`, per-type fields with kinds (`text`, `date`, `money`, `entity`,
  `last4`) and a `required` flag, per-type name templates, defaults (`date_format`,
  `date_order`, `max_name_length`, `ocr_text_layer`, `finder_tags`,
  `finder_comment`), an entity alias map, and the model split (a cheap model id for
  text-only calls and a vision model id for calls carrying images).
- R2: Ship a compiled list of the most common document types for a home and work
  computer in the YAML — a superset of the spec's 14 (invoice, bank_statement,
  letter, receipt, tax_form, payslip, contract, insurance_policy, utility_bill,
  medical, warranty, id_document, certificate, manual) plus `other`, which is
  always present as the fallback.
- R3: All model calls (classify + extract, text and vision) go through
  `@earendil-works/pi-ai` v1.3.0, imported and connected via that library — no
  hand-rolled provider HTTP layer. Cloud-first, vision-capable provider configured
  through it.
- R4: Stage 1 read ladder, cheapest first: direct text extraction for
  txt/md/docx/xlsx/pptx/pages; PDF text layer when usable (≥200 mostly-word chars);
  otherwise page rendering (max 3 pages, 200 dpi) and OCR; vision-model fallback
  only when OCR is weak (<200 chars or mean confidence <0.6). Text capped at 4000
  chars. iCloud placeholders downloaded first via `brctl download`.
- R5: PDF text, page rendering and OCR use Apple-native tooling where possible —
  macOS Vision via `shortcuts` for OCR, built-in tools for PDF text.
- R6: Stage 2: one model call per file returns type (enum), type_confidence,
  exactly that type's fields, per-field `evidence` quotes, and a ≤20-word summary
  (the Finder comment the apply half will write). Structured-output mode where the
  provider has one; otherwise JSON validated in code with one repair retry, then a
  `Failed` result. Text-only calls use the config's cheap model; calls carrying
  images use the config's vision model.
- R7: Stage 3 validation is code-side: flags for low type confidence (<0.6),
  missing required fields, evidence not fuzzy-found in extracted text, implausible
  dates (unparseable, >today+60d, <1980-01-01); money normalised to "amount ISO"
  (e.g. `482.50 GBP`); entities canonicalised via the alias map with legal-suffix
  tidying; a `last4` field reduced to its last four digits. Missing required fields
  retarget the row to `other`.
- R8: Ambiguous slashed dates are read day-first (03/04/2026 = 3 April 2026),
  driven by `date_order` in config, not guessed.
- R9: Stage 4 builds the name from the type's template: empty parts dropped
  cleanly, filesystem-unsafe characters removed, names shortened to
  `max_name_length` (cutting `subject`/`number` first), extension lowercased,
  collisions resolved with Finder-style ` (2)`, ` (3)` suffixes within both the
  folder and the current plan.
- R10: `docnamer plan <folder>` writes `<folder>/.docnamer-plan.json` containing a
  row per file with old name, proposed new name, type, fields, evidence, flags,
  summary, size, mtime and status `pending`, prints the old→new table with flagged
  rows first, and supports `--recursive` and `--apply-unflagged`.
- R11: `plan` renames, moves and rewrites nothing; plan files are plain JSON the
  user can delete; no database, no library of renamed files, no background process.

## Acceptance criteria

1. `docnamer plan <folder>` on a folder of mixed PDFs/images writes
   `.docnamer-plan.json` with old→new names, type, fields, evidence, flags,
   summary, size/mtime and status, and leaves every original file's name, size and
   mtime unchanged.
2. Flagged rows (low confidence, missing required fields, unverified evidence,
   implausible dates) are presented first in the plan output.
3. Two documents that render the same name produce `name (2).pdf`, never a
   collision, and never an overwrite of an existing file.
4. A scanned PDF whose OCR is weak is planned from a vision-model call, while a PDF
   with a usable text layer sends no image to the model.
5. A missing required field retargets the row to `other` rather than emitting a
   name with an empty part.
6. `03/04/2026` is planned as 3 April 2026 under `date_order: day-first`.

## Out of scope

- `apply`, `undo`, the review TUI, Spotlight extras, `eval` and the
  compile/install step — all in `doc-renamer-apply`.
- pi extension (spec Layer 2) and SKILL.md (Layer 3) — settled by D1.
- Any published or importable library API — settled by D3.
- Folder moves by type/year — rename in place only; the `folder` config key is
  parsed but ignored.
- Local model stack; cloud-first only via the pi provider library.
- OCR text-layer rewriting via `ocrmypdf` (that is an apply-time mutation).
- Multi-folder or watch-mode/background operation; one folder per invocation.

## Approaches

- A1: Which pi-ai entry point is imported for model calls, and does it expose structured output and a cheap/vision split? — terms: pi-ai, structured-output
- A2: How is macOS Vision OCR invoked via `shortcuts`, and does it return a usable confidence score? — terms: shortcuts, Vision
- A3: Which Apple-native tool reads a PDF's text layer? — terms: text-layer, PDF

## Risks

- pi-ai's API surface may not expose structured-output mode or a cheap/vision model
  split, forcing an adapter layer (R3, R6). Mitigated by A1 and by T3's test, which
  exercises the real call against the configured provider rather than a fake.
- Apple-native OCR via `shortcuts` may return no usable confidence score, making
  the Stage 1 weak-OCR threshold unmeasurable (R4, R5). Mitigated by A2 and by T2's
  test, which asserts the parsed confidence or fails loudly; the char-count arm of
  the threshold still works if the score is absent.
- The user may hold no API key for the provider pi-ai defaults to, blocking live
  classify/extract runs until configured (R3). T3's test names the missing
  credential as its failure rather than skipping.
- Vision-page rendering at 200 dpi may exceed the provider's image limits for
  large pages (R4). Mitigated by capping at 3 pages and by T2's test on a
  multi-page fixture.

## Open questions resolved by interview

| Question | Answer |
| --- | --- |
| Model setup | Cloud first, vision-capable, one provider; via pi-ai v1.3.0 |
| PDF/OCR tools | Apple-native only (Vision via `shortcuts`) for reading |
| Date order | Day-first |
| Doc types | Compiled list of most common home/work types (superset of spec's 14 + other) |
| Where this feature ends | At a working `docnamer plan <folder>`; apply/undo/eval are the second feature |
