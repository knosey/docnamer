# Doc Renamer Spec: Classify, Extract, Name

Oct 11, 2026 · @Tom

## Purpose and principles

A command-line tool you point at one folder: it reads each document, works out what it is, and renames it in place to a consistent, Spotlight-friendly name. It leaves nothing that needs it later: no database, no library, no background process. Finder stays the only place you manage files, and Spotlight is the index.

| Principle | Borrowed from | What it means here |
| --- | --- | --- |
| Cheapest read first | renamr | PDF text layer, then local OCR, then a vision model only when OCR is weak |
| Know what you are looking for | CookBook | Classify the document type first, then extract that type's fixed set of fields |
| Your fields, your names | NameQuick | Fields described in plain English; one name template per type, with formatted dates |
| Review before change | CookBook, NameQuick | A plan is shown first; nothing is renamed until you approve it |
| Non-sticky | Your requirement | Only the filename, Finder tag and Finder comment change; plan and undo files are plain JSON you can delete |

## Pipeline overview

&#91;embedded content: pipeline · 5 steps per file\]

Steps 1 to 4 run for every file and only write a plan; step 5 is the only one that touches your files.

## Config: types, fields and templates

One JSON file, `docnamer.json`, holds the whole behaviour: about 15 document types, each with a plain-English description, its fields and its own name template. The descriptions are the prompt, so tuning the tool mostly means editing this file.

```json
{
  "defaults": {
    "date_format": "YYYY-MM-DD",
    "date_order": "day-first",
    "max_name_length": 150,
    "ocr_text_layer": true,
    "finder_tags": true,
    "finder_comment": true
  },
  "models": { "cheap": "...", "vision": "...", "strong": "..." },
  "types": {
    "invoice": {
      "describe": "A bill asking for payment for goods or services",
      "fields": {
        "date":   { "prompt": "Invoice date printed on the document", "kind": "date", "required": true },
        "vendor": { "prompt": "Company that issued the invoice", "kind": "entity", "required": true },
        "number": { "prompt": "Invoice number, often starting INV or #" }
      },
      "template": "{date} {vendor} - Invoice - {number}",
      "tag": "Invoice",
      "folder": null
    },
    "bank_statement": {
      "describe": "Periodic statement for a bank or card account",
      "fields": {
        "date":    { "prompt": "Statement period END date", "kind": "date", "required": true },
        "bank":    { "prompt": "Bank or card issuer", "kind": "entity", "required": true },
        "account": { "prompt": "Last 4 digits of the account number", "kind": "last4" }
      },
      "template": "{date} {bank} - Statement - {account}",
      "tag": "Bank"
    },
    "letter": {
      "describe": "Correspondence addressed to me",
      "fields": {
        "date":    { "prompt": "Date printed on the letter", "kind": "date", "required": true },
        "sender":  { "prompt": "Organisation or person who sent it", "kind": "entity", "required": true },
        "subject": { "prompt": "What it is about, 3 to 6 words" }
      },
      "template": "{date} {sender} - Letter - {subject}",
      "tag": "Correspondence"
    },
    "other": {
      "describe": "Anything that fits no type above",
      "fields": {
        "date":    { "prompt": "Main date printed on it", "kind": "date" },
        "sender":  { "prompt": "Who produced it, if clear", "kind": "entity" },
        "subject": { "prompt": "What it is, 3 to 6 words", "required": true }
      },
      "template": "{date} {sender} - {subject}"
    }
  },
  "entities": {
    "Barclays": ["Barclays Bank UK PLC", "Barclays Bank", "BARCLAYS"],
    "HMRC": ["HM Revenue & Customs", "HM Revenue and Customs"]
  }
}
```

The shipped roster is the same shape with the full 15 types, `receipt`, `tax_form`, `payslip`, `contract`, `insurance_policy`, `utility_bill`, `medical`, `warranty`, `id_document`, `certificate` and `manual` among them. `other` is always present and is used when nothing fits. A type's optional `folder` moves the file instead of renaming it in place (for example `"{year}/Invoices"`); `null` means rename in place. `date_order` decides how `03/04/2026` is read.

Field kinds are `text` (default), `date`, `entity` and `last4`; each kind has its own normaliser in Stage 3. A field's `prompt` doubles as its extraction instruction, which is the NameQuick idea.

## Stage 1: Read, cheapest method first

Most files never reach a vision model: real text comes from the PDF itself or local OCR, and page images go to the model only when OCR is weak. That keeps runs fast, cheap and private.

```
function read(file) -> Content:
  if file is .txt, .md, .docx, .xlsx, .pptx, .pages:
      return { text: first(extract_text(file), 4000 chars), images: [] }

  if file is PDF:
      text = pdf_text_layer(file)
      if usable(text):                       # >= 200 chars that are mostly words
          return { text: first(text, 4000), images: [] }
      pages = render_pages(file, max = 3, dpi = 200)   # scanned PDF
  else if file is image (png, jpg, heic, tiff):
      pages = [file]
  else:
      return SKIP("unsupported type")

  ocr = ocr_pages(pages)                     # Apple Vision or your OCR tool
  if ocr.chars >= 200 and ocr.mean_confidence >= 0.6:
      return { text: first(ocr.text, 4000), images: [] }

  # OCR is weak: let the model look at the page
  return { text: ocr.text,                   # may be empty, still a useful hint
           images: downscale(pages[0..1], long_edge = 1600 px) }
```

- Thresholds are starting values to tune (see Testing and tuning). renamr uses 20 characters and 0.5 confidence with a 1,000-character cap; this spec raises both because classification needs more context.
- Page 1 always goes first: letterheads, dates and reference numbers usually live there.
- iCloud placeholder files are downloaded first with `brctl download`, as renamr does.

## Stage 2: Classify and extract in one call

One model call returns the document type, that type's fields, and the exact words each field came from. The model sees every type and its fields together, so it classifies and extracts at once, as CookBook does with its fixed recipe fields.

```
function analyse(content, file, config) -> Analysis:
  schema = build_schema(config.types)
  #  {
  #    type:            enum(all type names),
  #    type_confidence: number 0..1,
  #    fields:          one object per type, chosen by `type`:
  #                     { <field>: { value: string | null, evidence: string | null } },
  #    summary:         string, max 20 words   # becomes the Finder comment
  #  }

  system = """
    You identify personal documents and extract fields for filing.
    1. Pick exactly one type from the list below.
    2. Fill only that type's fields.
    3. Use only what is printed in the document. Never use file dates.
    4. For each field, copy the exact words you took it from into `evidence`.
    5. If a field is not printed, return null. Do not guess.
    6. Dates as YYYY-MM-DD. Money as amount plus ISO currency code.
  """ + render_type_list(config.types)    # name, describe, each field's describe

  user = [
    "Original filename: " + file.name,
    content.text or "[no text extracted]",
    ...content.images                     # only when Stage 1 fell back to vision
  ]

  result = model.call(system, user, json_schema = schema, temperature = 0)
  if not schema.valid(result):
      result = model.call(..., plus "Fix this error: " + validation_error)
  if still invalid:
      return FAILED(file)
  return result
```

- The `evidence` quotes do two jobs: Stage 3 checks them against the text to catch invented values, and the review screen shows them beside each name.
- Use the provider's structured-output mode where it has one; otherwise ask for JSON and validate it yourself, as renamr does.
- Text-only calls go to a cheaper model; calls with images go to the vision model (renamr's split).

## Stage 3: Validate and normalise

Code, not the model, has the last word on dates, entities and names, and anything doubtful is flagged for review rather than silently accepted.

```
function validate(a: Analysis, content, config) -> Checked:
  flags = []
  if a.type_confidence < 0.6:  flags.add("unsure of type")

  for each (name, field) in a.fields:
      spec = config.types[a.type].fields[name]
      if field.value is null:
          if spec.required: flags.add("missing " + name)
          continue

      if content.text and not fuzzy_contains(content.text, field.evidence):
          flags.add(name + ": evidence not found in document")   # likely invented

      switch spec.kind:
        date:   v = parse_date(field.value, config.defaults.date_order)
                if v is null or v > today + 60 days or v < 1980-01-01:
                    flags.add(name + ": implausible date")
        entity: v = canonical(field.value, config.entities)  # alias map, else tidy case
        last4:  v = last(digits(field.value), 4)
        text:   v = tidy(field.value)                   # trim, collapse spaces
      a.fields[name] = v

  if any required field missing:
      flags.add("missing required field <name>")   # the empty slot is dropped by the template
  return { ...a, flags }
```

- `parse_date` borrows renamr's tolerant parser (ISO, dotted, slashed, month names) but takes day-first or month-first from config instead of guessing.
- `tidy` for entities removes legal suffixes such as Ltd, PLC, GmbH and Pty Ltd unless the alias map says otherwise.

## Stage 4: Build the name

The type's template is filled from the checked fields, empty parts are dropped cleanly, and the result is made safe and unique in its folder.

```
function build_name(checked, config, file, planned) -> string:
  t = config.types[checked.type].template
  s = render(t, checked.fields,
             date -> format(value, config.defaults.date_format))
  s = drop_empty_parts(s)        # no number -> "... - Invoice", not "- Invoice -  -"
  s = sanitise(s)                # remove / : * ? " < > |, collapse spaces, trim . and -
  s = shorten(s, config.defaults.max_name_length,
              cut_first = ["subject", "number"])  # date, entity and type stay whole
  name = s + lowercase(file.ext)

  # unique within the folder AND within this run's plan
  n = 2
  while exists(file.dir, name) or name in planned:
      name = s + " (" + n + ")" + lowercase(file.ext)   # Finder-style suffix
      n += 1
  return name
```

Example results: `2026-03-14 Acme - Invoice - INV-1042.pdf`, `2026-02-28 Barclays - Statement - 1234.pdf`, `2026-04-05 HMRC - Letter - Self Assessment reminder.pdf`. Words stay separated by spaces so Spotlight treats each as its own word; worth a quick test on your Mac.

## Stage 5: Plan, review, apply, undo

Stages 1 to 4 only write a plan; the one step that touches your files is `apply`, after you have approved each row.

```
command plan(folder, recursive = false):
  files = list(folder, recursive)
          minus hidden files, minus files already matching a template
  download any iCloud placeholders first
  for each file, at most 3 at a time:
      content  = read(file)                          # Stage 1
      analysis = analyse(content, file, config)      # Stage 2
      checked  = validate(analysis, content, config) # Stage 3
      new      = build_name(checked, config, file, plan.names)  # Stage 4
      plan.add({ old: file.name, new, type, fields, evidence, flags,
                 size: file.size, mtime: file.mtime, status: "pending" })
  save folder/.docnamer-plan.json
  print table old -> new, flagged rows first

command review(folder):                              # small TUI
  rows from .docnamer-plan.json, flagged rows first
  each row shows: old name, new name, type, flags, evidence quotes
  keys: Enter accept | e edit name | t change type and re-run Stage 4 | s skip
        A accept all unflagged rows

command apply(folder):
  for each accepted row:
      if file size or mtime changed since plan: skip and report
      rename(old, new)                               # same folder
      if type.folder set: move into it                # optional, off by default
      if tags on:     add_finder_tag(new, type.tag)
      if comments on: set_finder_comment(new, summary)
      undo.add({ old, new, moved_to, at: now })
  save folder/.docnamer-undo-<timestamp>.json
  delete .docnamer-plan.json

command undo(folder, run = latest):
  for each entry in reverse:
      if new exists and old name is free: rename back (and move back)
  delete that undo file
```

Shortcut for confident runs: `docnamer plan --apply-unflagged` accepts every row without flags and leaves the rest for review.

## Spotlight extras

Everything the tool writes is standard macOS metadata, so Finder and Spotlight read it without the tool installed.

| What | How it is written | How you find it | Default |
| --- | --- | --- | --- |
| Filename | Rename in place | Type any word or `2026-03` in Spotlight | On |
| Finder tag per type | `tag --add Invoice file` (`brew install tag`), or write the `_kMDItemUserTags` attribute directly | `tag:Invoice` in Spotlight, or the Finder sidebar | On |
| Finder comment (the 20-word summary) | Finder AppleScript: `set comment of (POSIX file p as alias) to s`, so Get Info and Spotlight both see it | Spotlight searches comment text | Off (slower: one Finder call per file) |
| Searchable text layer for scans | `mac-ocr searchable-pdf in.pdf out.pdf`, then replace the original | Spotlight finds any word on the page | Off (it rewrites the file) |

PDFs that already have text are searchable by content today; only scans and photos need the OCR layer.

## pi integration

Build the core as a plain TypeScript library and CLI, then give pi a thin extension over it, so the renaming is deterministic and pi handles the conversation.

```
# Layer 1: library + CLI (works without pi)
docnamer plan   <folder> [--recursive] [--apply-unflagged]
docnamer review <folder>
docnamer apply  <folder>
docnamer undo   <folder>
docnamer eval   <testset>          # see Testing and tuning

# Layer 2: pi extension registering three tools
tool docnamer_plan(folder, recursive?)   -> plan rows (old, new, type, flags, evidence)
tool docnamer_apply(folder, accept: row ids | "unflagged", edits?: {row: new name})
tool docnamer_undo(folder)

# Layer 3: SKILL.md
- Use docnamer_plan when asked to tidy, rename or sort documents in a folder.
- Always show the plan, flagged rows first, before calling docnamer_apply.
- Never apply rows the person has not accepted.
- To change how a type is named, edit docnamer.json, then re-plan.
```

- Model calls go through the same provider layer your pi setup already uses, so local models and API keys are shared.
- Your existing TypeScript doc tools plug into `extract_text`, `pdf_text_layer`, `render_pages` and `ocr_pages` in Stage 1.
- A skill on its own (pi reading each file and renaming it by hand) would work but runs slower, costs more per file and gives less consistent names; that is why the loop lives in code.

## Testing and tuning

The code takes a day or two; getting names right on your documents is the real work, so build a small scored test set first.

```
testset/
  files/               40-60 of your real documents, every type, incl. worst scans
  expected.json        per file: type, each field, full expected name

command eval(testset):
  for each file: run Stages 1-4 (no rename)
  score: type accuracy, per-field exact match, full-name match,
         share of files that needed vision, time and cost per file
  print the misses side by side: expected vs got, with evidence
```

1. Fix misses in this order: type `describe` text, then field `describe` text, then Stage 1 thresholds, then the model.
2. Re-run `eval` after every change and keep the scores in a log.
3. Run the same set through one local model and one cloud model, and compare accuracy against time and cost.
4. Suggested bar before using `--apply-unflagged`: type 95% or better, dates 95% or better, full names 85% or better. These are my starting targets, not measured figures.

## Size and open questions

About 700 lines of TypeScript plus the JSON config, assuming your existing doc tools already handle PDF text, page rendering and OCR. That is more than my earlier 450 to 550 estimate because it now includes the review screen, validation and the eval command.

| Part | Approx. lines |
| --- | --- |
| Stage 1: read ladder (wrapping your doc tools) | 80 |
| Stage 2: schema builder and model call | 120 |
| Stage 3: validation and normalisers | 120 |
| Stage 4: name rendering and collisions | 70 |
| Stage 5: plan, review screen, apply, undo | 150 |
| Finder tags and comments | 40 |
| pi extension and skill | 60 |
| Eval command | 60 |
| Total | \~700 |

- [x] Read ambiguous dates such as 03/04/2026 day-first or month-first? — day-first, driven by `date_order` in `docnamer.json` (docs/features/doc-renamer-pipeline/BRIEF.md, R8)
- [x] Rename in place only, or also move into folders by type and year? — rename in place by default; a type may name a `folder` and the move is then part of the plan (docs/features/doc-renamer-pipeline/WORKPLAN.md, the Config type)
- [x] Local model, cloud model, or local first with cloud for flagged files? — cloud-first and vision-capable, one provider through pi-ai, with a cheap model id for text calls and a vision model id for calls carrying images (docs/features/doc-renamer-pipeline/BRIEF.md, R3)
- [x] Which of your TypeScript tools cover PDF text, page rendering and OCR? — settled while the read ladder was designed, from the research answers in docs/features/doc-renamer-pipeline/BRIEF.md (R4 and A3)
- [x] Add an OCR text layer to scans (rewrites the file), or leave originals untouched? — add it, via `mac-ocr searchable-pdf`, off by default and only under `ocr_text_layer` (docs/features/doc-renamer-apply/BRIEF.md, R5)
- [x] Which 15 or so document types do you actually have? — the shipped roster in `docnamer.json`: 15 types plus `other` (docs/features/doc-renamer-pipeline/BRIEF.md, R2)
