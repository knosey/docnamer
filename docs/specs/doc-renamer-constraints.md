# docnamer — decisions already made

Operator decisions, recorded before the brainstorm interview. Each is settled.
Open questions are listed at the end and are the only things the interview
needs to ask about.

## D1. Shape: one standalone bundled application

The deliverable is one standalone CLI application, bundled to a single
self-contained executable and installed locally on this machine. It does not
call pi, and it is not an extension of the pi editor.

Operator's words: "the cli is a stand alone single bundled app, that i will
install locally, this is not calling or an extension of the pi editor"

Settled consequences: the spec's Layer 2, a pi extension registering three
tools, is out of scope. Layer 3, the SKILL.md, is out of scope. There is no
dependency on `@earendil-works/pi-coding-agent`.

Bundling is `bun build --compile`. Verified on this machine with bun 1.4.2: it
produces a 62 MB Mach-O arm64 executable that runs standalone.

## D2. Runtime: native Bun, never node

The application uses Bun's own APIs throughout: `Bun.file`, `Bun.$`,
`Bun.Glob`, `Bun.spawn`, `Bun.YAML`, `bun:sqlite`. It uses no `node:`
built-ins. Using Bun's own APIs is the point, not a portability compromise.

Operator's words: "use native bun", "not node", "its what bun does"

## D3. Entry point: the CLI subprocess, and nothing else

`docnamer <command> <folder>` is the entire integration surface. Any host, a
shell script, a LaunchAgent or an editor, calls the application as a subprocess.
There is no published or importable library API for a host to import.

Internally the code may still be organised as modules. It is the external
surface that is CLI-only.

## Open questions

The interview should ask about these, and about nothing in D1 to D3.

1. Where does the binary install? `~/.local/bin` is chezmoi-managed on this
   machine, so a file placed there becomes chezmoi-tracked. Alternatives are
   `/usr/local/bin`, a plain `~/bin`, or a project-local path.
2. Read ambiguous dates such as 03/04/2026 day-first or month-first?
3. Rename in place only, or also move into folders by type and year?
4. Local model, cloud model, or local first with cloud for flagged files?
5. Which local tools cover PDF text, page rendering and OCR? Installed today:
   `shortcuts` and `brctl` are present; `tag` and `ocrmypdf` are not.
6. Add an OCR text layer to scans, which rewrites the file, or leave originals
   untouched?
7. Which fifteen or so document types does the operator actually have?

Further open questions are carried in the spec itself, at
docs/specs/doc-renamer.md.
