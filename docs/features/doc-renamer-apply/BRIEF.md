# BRIEF: doc-renamer-apply

The second half of `docnamer`: turning an approved plan into renamed files, with a
reversible record, Spotlight metadata, a small review TUI, an accuracy command, and
a single standalone binary installed to `~/bin`.

This feature begins where `doc-renamer-pipeline` ends: it requires that feature to
have shipped `src/config.ts`, `src/read.ts`, `src/analyse.ts`, `src/validate.ts`,
`src/name.ts`, `src/commands.ts` and `src/cli.ts`, with `docnamer plan <folder>`
working.

Full context: `docs/specs/doc-renamer.md` and
`docs/specs/doc-renamer-constraints.md`. Operator decisions D1–D4 are settled and
binding.

## Requirements

- R1: Single self-contained executable produced by `bun build --compile`; installs
  to `~/bin` (plain, not chezmoi-tracked), runs with no project checkout on disk
  and with no `node:` built-in anywhere in `src/`.
- R2: `docnamer apply <folder>` renames each accepted plan row in place to its new
  name, writes the type's Finder tag (and its comment when enabled), records every
  change in the undo file, and deletes the plan file.
- R3: Every apply run keeps a backup/restore record at
  `<folder>/.docnamer-undo-<timestamp>.json` so all changes can be undone until the
  user approves the result. `docnamer undo <folder>` restores original names from
  the latest run (or a named one) in reverse order, skipping and reporting any row
  whose size or mtime changed since apply, and never overwriting an occupied old
  name.
- R4: `docnamer review <folder>` presents each plan row with old name, new name,
  type, flags, evidence and summary; Enter accepts, `e` edits the name, `t` changes
  the type and re-runs Stage 4 to rebuild the name, `s` skips, and `A` accepts all
  unflagged rows while flagged rows stay pending. Row statuses are written back to
  the plan file.
- R5: OCR text layer for scanned PDFs uses `mac-ocr searchable-pdf`, replacing the
  original file, so Spotlight indexes page text. Off by default; when enabled the
  rewritten file is covered by the same undo record as the rename, and undo
  restores the pre-OCR bytes.
- R6: Spotlight extras: a Finder tag per type written directly to the
  `com.apple.metadata:_kMDItemUserTags` attribute as a binary plist (NSArray of
  `"TagName\nColorIndex"` strings — the `tag` binary is not installed), on by
  default; a Finder comment carrying the row's summary, off by default.
- R7: Apply skips and reports any file whose size or mtime changed since the plan
  was written; it never renames without an accepted row.
- R8: `docnamer eval <testset>` runs Stages 1–4 against a folder of files plus an
  `expected.json`, renaming nothing, and prints type accuracy, per-field exact
  match, full-name match, vision-fallback share, and time/cost per file, with each
  miss shown side by side with its evidence.

## Acceptance criteria

1. `bun build --compile` produces one standalone binary that runs on this machine
   with no project checkout and no `node:` imports in `src/`.
2. `docnamer apply <folder>` renames only accepted rows, writes Finder tags and
   (when enabled) comments, saves an undo file, and deletes the plan file.
3. `docnamer undo <folder>` restores original filenames from the latest undo record
   and deletes that undo file.
4. A file whose size or mtime changed since planning is skipped and reported, never
   renamed.
5. `mdls` on a renamed file surfaces the type's Finder tag.
6. `docnamer eval <testset>` prints the accuracy metrics from R8.
7. `docnamer review <folder>` changes a row's status in the plan file, and `t`
   rebuilds the proposed name from the new type's template.

## Out of scope

- The read ladder, classification, validation, naming and the `plan` command — all
  in `doc-renamer-pipeline`, which this feature requires.
- pi extension (spec Layer 2) and SKILL.md (Layer 3) — settled by D1.
- Any published or importable library API — settled by D3.
- Folder moves by type/year — rename in place only.
- Local model stack; cloud-first only via the pi provider library.
- brew-installed `tag`; `tag`-based tagging.
- Multi-folder or watch-mode/background operation; one folder per invocation.

## Approaches

- A1: How are Finder user tags written without the `tag` binary, and does Spotlight surface them? — terms: _kMDItemUserTags, xattr
- A2: How is a Finder comment written from a CLI? — terms: Finder, AppleScript
- A3: What does `mac-ocr searchable-pdf` do to a file that already has a text layer? — terms: mac-ocr, searchable-pdf

## Risks

- `mac-ocr` is a project dependency (`bun add mac-ocr`), resolved by the CLI from
  `node_modules` and never from a global install; R5 depends on that dependency
  being present. T1's test names the missing binary as its failure and
  `tests/holes.md` records the manual smoke (`bun add mac-ocr`), rather than
  skipping green.
- Writing `_kMDItemUserTags` directly is undocumented-adjacent; Finder/Spotlight may
  not surface tags written this way (R6). Mitigated by T1's test, which reads the
  attribute back with `mdls` rather than trusting the write.
- The undo record's plain-JSON rule (R3) and R5's byte-restore of a `mac-ocr`
  rewrite pull against each other: JSON can carry a path and a hash, not the
  original bytes. Resolved by storing a sidecar copy of the original next to the
  undo record and naming that path in the JSON, so the record stays plain JSON and
  the bytes are restorable.
- The user may hold no API key for the provider, so `eval` (R8) cannot run live
  until configured. T3's test names the missing credential as its failure.

## Open questions resolved by interview

| Question | Answer |
| --- | --- |
| Install path | `~/bin` (plain, not chezmoi-managed) |
| Folder moves | No; backup/restore (undo) required until the user approves |
| OCR text layer | Yes, via `mac-ocr searchable-pdf`, off by default |
| Tags | Written directly to `_kMDItemUserTags`; `tag` is not installed |
| Comment | Finder AppleScript, off by default |
| Where this feature begins | After `doc-renamer-pipeline` has shipped `docnamer plan` |
