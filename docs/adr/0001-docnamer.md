# 0001. docnamer is one bundled Bun CLI that renames a folder of documents from a JSON type roster

- Status: accepted
- Date: 2026-11-05

## Context

The operator wanted a tool he points at one folder: it reads each document, works out what it is,
and renames it in place to a name he would have chosen himself, so Finder and Spotlight find it
later. `scan_0047.pdf` becomes `2024-03-12 Acme Services invoice INV-2024-0817.pdf`.

Four decisions were taken before any design work, and they fix the shape of everything after them.
His words are recorded because they are the reason, not a paraphrase of it.

- D1 — One standalone bundled application, installed locally: "the cli is a stand alone single
  bundled app, that i will install locally, this is not calling or an extension of the pi editor".
  So no pi extension, no skill, and no dependency on `@earendil-works/pi-coding-agent`.
- D2 — Native Bun throughout, "use native bun", "not node", "its what bun does": `Bun.file`,
  `Bun.write`, `Bun.spawn`/`Bun.spawnSync` and `Bun.Glob` carry the file, process and folder work,
  and no database is opened at all. `node:` built-ins appear only where Bun has no equivalent:
  `node:path` to resolve the binary's own location (`src/cli.ts:9`) and `node:fs`/
  `node:fs/promises` for the owner-only credential write (`src/auth.ts:18-20`), which needs an
  atomic rename and a mode `Bun.write` does not offer. Using Bun's own APIs is the point, not a
  portability compromise.
- D3 — The CLI subprocess is the entire integration surface. A shell script, a LaunchAgent or an
  editor calls `docnamer <command> <folder>`; nothing imports the code as a library.
- D4 — Every model call goes through pi's own model layer, `@earendil-works/pi-ai` (1.5.0, which
  this tree installs), text and vision alike. A hand-rolled provider HTTP layer is not written.
  That library is the model layer only and does not depend on the editor package D1 excludes.

Three forces shaped the rest. Renaming is destructive the moment it is wrong, so nothing is
renamed until the operator has seen a plan and approved each row, and every run leaves a record
that puts the names back. A folder of mixed paperwork must not cost a model call per file, so a
file is read by the cheapest method that suffices, and a model is asked only for what the file
does not already say. And the behaviour belongs to the operator, not to the code: which types
exist, what each type's fields are and how each one is named live in one JSON file whose plain
English descriptions are the prompt, so tuning the tool is editing that file.

The one absolute requirement is non-stickiness. Only the filename, the Finder tag and the Finder
comment change; the plan and the undo record are plain JSON the operator can delete, and there is
no database, no library of what was renamed and no background process.

## Decision

docnamer is one standalone Bun-compiled macOS CLI installed at `~/bin/docnamer`, with `plan`,
`review`, `apply`, `undo`, `eval` and the provider-credential commands as its whole surface. It
reads a document by the cheapest sufficient method, classifies it against the JSON type roster,
extracts that type's fields, decides dates, entities and the final name in code rather than trusting
the model, writes a plan, and changes files only on `apply`, recording every change so `undo` can
put them back. Nothing it writes needs it later: Finder and Spotlight read the result without it.

It is built in four features, each with its own ADR:

- 0002, the read ladder, classification, validation, naming and `plan` — the half that touches no
  file.
- 0003, `apply`, `undo`, `review`, `eval`, the Spotlight metadata and the compile-and-install step.
- 0004, the naming rules that decide who is named, which filename tokens are printed and how long
  a name may be.
- 0005, the terminal pass that makes the screen usable and leaves the shell clean.

## Alternatives considered

- A pi extension registering renaming tools, with a skill telling pi when to call them — settled
  against by the operator's first decision. A skill alone, with pi reading each file and renaming
  by hand, would also work, but runs slower, costs more per file and gives less consistent names,
  which is why the loop lives in code.
- A published or importable library API for a host to call — rejected: the CLI subprocess is the
  surface, and a second one is a second contract to keep.
- A local model stack, or local-first with a cloud model for flagged files — settled as
  cloud-first and vision-capable, one provider through pi's model layer, so the choice of model is
  a config value rather than a second code path.
- Node built-ins for portability — rejected by the operator; this program is Bun's, not a
  portable Node program.
- A database or index of renamed files, so the tool could recognise a file it had already named —
  rejected: it would outlive the run and make the tool something to maintain. A file already
  wearing a template name is recognised from its name instead.
- Remembering the current state in the plan file alone, with no undo record — rejected: renaming
  is the one irreversible act here, so the record that reverses it is written in the same run.

## Consequences

- The program is one binary the operator installs and one JSON file he edits. Changing how a type
  is named is editing `docnamer.json`; no code changes and no rebuild.
- macOS-only, deliberately. The OCR, the Finder tags and the Finder comments are Apple frameworks,
  and on any other system the program fails at the first of them rather than pretending.
- Being one process with no server, no watcher and no queue, `plan` is bounded by how fast the
  provider answers, and the answer is the same file content twice rather than cached.
- Because the model is asked only for what the file does not say, a document that states nothing
  still needs a model call; the file's old name is sent with the page for exactly that reason.
- Everything the operator can undo stays undone only until he deletes the undo file, and that
  deletion is his to make — the program never prunes what it wrote.
