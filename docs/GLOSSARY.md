# GLOSSARY

What each word means in docnamer. The name in parentheses is the one in the code.

**Plan** — the proposal for a folder: one row per file, with the name it has and the name it would
get. Written by `plan`, and the only thing `plan` writes. (`plan`, `.docnamer-plan.json`)

**Plan row** — one file's proposal: old name, new name, type, fields, quotes, flags, summary, size,
modification time and status. Its status is `pending` until a person accepts or skips it.

**Flag** — the reason a row may be wrong: a type the model was unsure of, a required field the page
does not carry, a value whose quote is not on the page, an implausible date. Flagged rows are shown
first, and a flag is never a refusal. (`flag`)

**Review** — the screen where a person accepts, edits, skips or re-types each row. It changes the
plan file, never a document.

**Apply** — the only command that renames a file. It renames accepted rows, writes the Spotlight
extras and records what it did. (`apply`)

**Undo** — the command that puts the names back from a run's record, in reverse order, skipping any
file that changed since. (`undo`)

**Run record** — the undo file one apply writes: `<folder>/.docnamer-undo-<timestamp>.json`. Plain
JSON, and deleting it is how a run stops being reversible. (`undo record`)

**Type** — one kind of document the roster knows, such as invoice or passport, with the plain
English description the model reads, its fields, its template and its Finder tag. `other` is always
present and catches what fits nothing. (`type`)

**Roster** — every type the config holds. The shipped one is compiled in; a folder that carries its
own `docnamer.json` replaces the roster wholesale rather than merging with it. (`types`)

**Field** — one value a type reads from a page, with the prompt that asks for it and the kind that
says how it is cleaned before it names anything. A `required` field the page does not carry flags
the row instead of naming it wrongly. (`field`)

**Kind** — how a field's value is normalised: `text`, `date`, `entity`, `money` or `last4`.
(`FieldSpec.kind`)

**Template** — a type's name, written as fields in braces with literal text between them. An empty
field drops its part of the name cleanly. (`template`)

**Quote** — the exact words a field's value was taken from, returned by the model and checked against
the page. A value whose quote is not on the page is the likely-invented case, and is flagged.
(`evidence`)

**Summary** — the model's twenty-word description of the document, which becomes the Finder comment
when comments are enabled. (`summary`)

**Self** — the companies that are yours. An invoice or a contract issued by one of them is named
after the customer, never after you. (`self`)

**Entity** — a name with one canonical spelling, so Barclays Bank UK PLC and BARCLAYS both print as
Barclays. (`entities`)

**Extras** — the three things written beside a filename: a Finder tag per type, a Finder comment, an
optional searchable text layer for a scan. All ordinary macOS metadata, so none of it needs docnamer
to be read back. (`spotlight`)

**Sidecar** — the copy of a scan's original bytes an OCR rewrite leaves beside the run record, so
`undo` can restore a file the text layer replaced. (`sidecar`)

**Read ladder** — the order a file is read in, cheapest first: its own text, a PDF's text layer, OCR
of a rendered page, and a vision model only when OCR is weak. (`read`)

**Weak OCR** — the point the ladder stops trusting the Mac's own read and sends page images to the
model: under 200 characters, or mean confidence under 0.6.

**Stage** — one of the four steps that turn a file into a name: read, classify-and-extract, validate,
name. The fifth, apply, is the only one that touches a document.

**Eval** — the command that scores the four stages against a folder of real documents and an
expected list, renaming nothing. (`eval`)

**Test set** — the folder `eval` scores: the documents, and `expected.json` with the type, fields and
full name each should produce. (`testset`)

**Interaction** — one observable end state a feature commits to, in its ADR, with a digraph of the
steps a person takes to reach it. Each has one E2E test. (`I<n>`)

**Requirement** — one checkable statement in an ADR, of what the operator needs. A task in a
WORKPLAN covers it by id. (`R<n>`)

**Workplan** — the tasks a feature is built from, in build order, each with the file it touches, the
command its completion is checked by and the ids it covers. (`WORKPLAN.md`)
