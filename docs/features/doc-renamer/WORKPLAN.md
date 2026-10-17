# WORKPLAN: doc-renamer

## Global Constraints
- Single self-contained executable produced by `bun build --compile`; installs to `~/bin` (plain, not chezmoi-tracked) — R1.
- Native Bun APIs only (`Bun.file`, `Bun.$`, `Bun.Glob`, `Bun.spawn`, `Bun.YAML`, `bun:sqlite`); no `node:` built-ins anywhere in the codebase — R2.
- All model calls go through `@earendil-works/pi-ai` version 1.3.0; no hand-rolled provider HTTP layer — R3, D4.
- `docnamer <command> <folder>` is the entire integration surface; no importable library API — D3.
- Ambiguous slashed dates are read day-first, driven by `date_order` in config — R10.
- Rename in place only; the `folder` config key is parsed but ignored — R13.
- Finder tags are written directly to the `com.apple.metadata:_kMDItemUserTags` xattr as a binary plist (NSArray of strings `"TagName\nColorIndex"`), never a plain string and never the `tag` binary — R15.
- Nothing is renamed, moved or rewritten until the user approves plan rows; plan and undo files are plain JSON — R18.

## Setup
- `bun install`

## T0: Package manifest and toolchain
- Covers: R1, R2, R3
- Depends on: none
- Files:
  - Create: [package.json](../../../package.json)
  - Create: [tsconfig.json](../../../tsconfig.json)
  - Test: [manifest.test.ts](../../../tests/manifest.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: a `package.json` declaring `@earendil-works/pi-ai` pinned at exactly `1.3.0`, `"type": "module"`, and the scripts `build` (`bun build --compile --outfile ~/bin/docnamer src/cli.ts`) and `test` (`bun test`); a `tsconfig.json` with `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"target": "ESNext"`, `"strict": true`, `"noEmit": true`
- done_when: `bun test tests/manifest.test.ts`
- Reference: `bun pm ls`
<!-- record:T0 -->
<!-- /record:T0 -->

## T1: Config loader and shipped type roster
- Covers: R4, R5
- Depends on: none
- Files:
  - Create: [config.ts](../../../src/config.ts)
  - Create: [docnamer.yaml](../../../docnamer.yaml)
  - Test: [config.test.ts](../../../tests/config.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: `loadConfig(path: string): Config`; `type DocType = { describe: string; fields: Record<string, FieldSpec>; template: string; tag?: string; folder?: string | null }`; `type Config = { defaults: { date_format: string; date_order: "day-first" | "month-first"; max_name_length: number; ocr_text_layer: boolean; finder_tags: boolean; finder_comment: boolean }; types: Record<string, DocType>; entities: Record<string, string[]> }`
- done_when: `bun test tests/config.test.ts`
- Reference: `grep "^- R5" docs/features/doc-renamer/BRIEF.md`
<!-- record:T1 -->
<!-- /record:T1 -->

## T2: Stage 1 read ladder
- Covers: R6, R7, I5
- Depends on: T1
- Files:
  - Create: [read.ts](../../../src/read.ts)
  - Test: [read.test.ts](../../../tests/read.test.ts)
- Interfaces:
  - Consumes: `loadConfig(path: string): Config`; `type Config`
  - Produces: `read(file: string, config: Config): Promise<Content>`; `type Content = { text: string; images: string[] }`; `downloadICloud(file: string): Promise<void>`; `ocrPages(pages: string[]): Promise<{ text: string; chars: number; meanConfidence: number }>`
- done_when: `bun test tests/read.test.ts`
- Reference: `mdls -name kMDItemNumberOfPages -name kMDItemTextContent tests/fixtures/scan.pdf`
<!-- record:T2 -->
<!-- /record:T2 -->

## T3: Stage 2 classify-and-extract model call
- Covers: R3, R8
- Depends on: T1, T2
- Files:
  - Create: [analyse.ts](../../../src/analyse.ts)
  - Test: [analyse.test.ts](../../../tests/analyse.test.ts)
- Interfaces:
  - Consumes: `type Config`; `type Content`
  - Produces: `analyse(content: Content, fileName: string, config: Config): Promise<Analysis | Failed>`; `buildSchema(types: Record<string, DocType>): TSchema`; `type Analysis = { type: string; type_confidence: number; fields: Record<string, { value: string | null; evidence: string | null }>; summary: string }`
- done_when: `bun test tests/analyse.test.ts`
- Reference: `plutil -p /Users/<user>/.local/share/chezmoi/node_modules/@earendil-works/pi-ai/package.json`
<!-- record:T3 -->
<!-- /record:T3 -->

## T4: Stage 3 validation and normalisers
- Covers: R9, R10
- Depends on: T1, T3
- Files:
  - Create: [validate.ts](../../../src/validate.ts)
  - Test: [validate.test.ts](../../../tests/validate.test.ts)
- Interfaces:
  - Consumes: `type Analysis`; `type Config`; `type Content`
  - Produces: `validate(a: Analysis, content: Content, config: Config): Checked`; `type Checked = Analysis & { flags: string[] }`; `parseDate(value: string, order: "day-first" | "month-first"): string | null`; `normaliseMoney(value: string): string`; `canonicalEntity(value: string, aliases: Record<string, string[]>): string`
- done_when: `bun test tests/validate.test.ts`
- Reference: `date -j -f "%Y-%m-%d" "2026-04-03" "+%Y-%m-%d"`
<!-- record:T4 -->
<!-- /record:T4 -->

## T5: Stage 4 name building and collision safety
- Covers: R11, I6
- Depends on: T1, T4
- Files:
  - Create: [name.ts](../../../src/name.ts)
  - Test: [name.test.ts](../../../tests/name.test.ts)
- Interfaces:
  - Consumes: `type Checked`; `type Config`
  - Produces: `buildName(checked: Checked, config: Config, file: { dir: string; ext: string }, planned: Set<string>): Promise<string>`; `sanitise(s: string): string`; `renderTemplate(t: string, fields: Record<string, string>): string`
- done_when: `bun test tests/name.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T5 -->
<!-- /record:T5 -->

## T6: Spotlight extras — Finder tags, comments and OCR text layer
- Covers: R14, R15, R18
- Depends on: T1
- Files:
  - Create: [spotlight.ts](../../../src/spotlight.ts)
  - Test: [spotlight.test.ts](../../../tests/spotlight.test.ts)
- Interfaces:
  - Consumes: `type Config` (T1)
  - Produces: `setFinderTag(path: string, tag: string): Promise<void>`; `setFinderComment(path: string, comment: string): Promise<void>`; `addOcrTextLayer(path: string): Promise<void>`
- done_when: `bun test tests/spotlight.test.ts`
- Reference: `xattr -px com.apple.metadata:_kMDItemUserTags tests/fixtures/tagged.pdf`
<!-- record:T6 -->
<!-- /record:T6 -->

## T7: Stage 5 plan, apply, undo
- Covers: R12, R13, R16, I1, I3, I4
- Depends on: T2, T3, T4, T5, T6
- Files:
  - Create: [commands.ts](../../../src/commands.ts)
  - Test: [commands.test.ts](../../../tests/commands.test.ts)
- Interfaces:
  - Consumes: `read(file: string, config: Config): Promise<Content>`; `analyse(content: Content, fileName: string, config: Config): Promise<Analysis | Failed>`; `validate(a: Analysis, content: Content, config: Config): Checked`; `buildName(checked: Checked, config: Config, file: { dir: string; ext: string }, planned: Set<string>): Promise<string>`; `setFinderTag(path: string, tag: string): Promise<void>`; `setFinderComment(path: string, comment: string): Promise<void>`; `addOcrTextLayer(path: string): Promise<void>`
  - Produces: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `apply(folder: string, config: Config): Promise<void>`; `undo(folder: string, run?: string): Promise<void>`; `type PlanRow = { old: string; new: string; type: string; fields: Record<string, string>; evidence: Record<string, string>; flags: string[]; size: number; mtime: number; status: "pending" | "accepted" | "skipped" }`
- done_when: `bun test tests/commands.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T7 -->
<!-- /record:T7 -->

## T8: Review TUI and CLI entry
- Covers: R12, I2
- Depends on: T7
- Files:
  - Create: [cli.ts](../../../src/cli.ts)
  - Create: [review.ts](../../../src/review.ts)
  - Test: [review.test.ts](../../../tests/review.test.ts)
- Interfaces:
  - Consumes: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `apply(folder: string, config: Config): Promise<void>`; `undo(folder: string, run?: string): Promise<void>`; `type PlanRow`
  - Produces: `review(folder: string, config: Config): Promise<void>`; `main(argv: string[]): Promise<number>`
- done_when: `bun test tests/review.test.ts`
- Reference: `bun --version`
<!-- record:T8 -->
<!-- /record:T8 -->

## T9: Eval command
- Covers: R17, I7
- Depends on: T8
- Files:
  - Modify: [cli.ts](../../../src/cli.ts)
  - Create: [eval.ts](../../../src/eval.ts)
  - Test: [eval.test.ts](../../../tests/eval.test.ts)
- Interfaces:
  - Consumes: `read(file: string, config: Config): Promise<Content>`; `analyse(content: Content, fileName: string, config: Config): Promise<Analysis | Failed>`; `validate(a: Analysis, content: Content, config: Config): Checked`; `buildName(checked: Checked, config: Config, file: { dir: string; ext: string }, planned: Set<string>): Promise<string>`
  - Produces: `evalTestset(testset: string, config: Config): Promise<EvalReport>`; `type EvalReport = { typeAccuracy: number; fieldExactMatch: number; fullNameMatch: number; visionShare: number; avgSeconds: number; avgCost: number; misses: { file: string; expected: string; got: string; evidence: Record<string, string> }[] }`
- done_when: `bun test tests/eval.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T9 -->
<!-- /record:T9 -->

## T10: Compile, install and prove the binary standalone
- Covers: R1, R2
- Depends on: T9
- Files:
  - Create: [build.test.ts](../../../tests/build.test.ts)
- Interfaces:
  - Consumes: `main(argv: string[]): Promise<number>`
  - Produces: a `tests/build.test.ts` that runs `bun build --compile` into a temp path, executes the produced binary with `--version` and with a real `plan` run over a fixture folder, asserts exit 0 and the written plan file's rows, and asserts no `node:` specifier appears anywhere under `src/`
- done_when: `bun test tests/build.test.ts`
- Reference: `bun build --compile --outfile /tmp/docnamer-probe src/cli.ts`
<!-- record:T10 -->
<!-- /record:T10 -->
<!-- record:run -->
<!-- /record:run -->
