# WORKPLAN: doc-renamer-pipeline

## Global Constraints
- Native Bun APIs only (`Bun.file`, `Bun.$`, `Bun.Glob`, `Bun.spawn`, `Bun.YAML`, `bun:sqlite`); no `node:` built-ins anywhere in the codebase — R3, D2.
- All model calls go through `@earendil-works/pi-ai` version 1.3.0, declared in `package.json` and pinned exactly; no hand-rolled provider HTTP layer — R3, D4.
- `docnamer <command> <folder>` is the entire integration surface; no importable library API — D3.
- Ambiguous slashed dates are read day-first, driven by `date_order` in config — R8.
- `plan` renames, moves and rewrites nothing; `.docnamer-plan.json` is plain JSON — R11.
- `other` is always present in the type roster as the fallback and the retarget of last resort — R2, R7.
- Text handed to a model is capped at 4000 characters — R4.
- The `folder` config key is parsed but ignored; no folder moves in this feature — R1.
- Two documents of the same type carrying the same extracted field values MUST render to the same name before disambiguation; making them unique is Stage 4's job — I3.
- `tests/fixtures/` holds such a pair: two byte-identical bodies named `dup-invoice`, one with a `.txt` extension and one with `.md`, so a correct Stage 4 suffixes exactly one of them — I3, T2.

## Setup
- `mkdir -p ~/bin`

## T1: Config, shipped type roster and project manifest
- Covers: R1, R2
- Depends on: none
- Files:
  - Create: [package.json](../../../package.json)
  - Create: [docnamer.yaml](../../../docnamer.yaml)
  - Create: [config.ts](../../../src/config.ts)
  - Test: [config.test.ts](../../../tests/config.test.ts)
  - Test: [manifest.test.ts](../../../tests/manifest.test.ts)
- Interfaces:
  - Consumes: none
  - Produces: `loadConfig(path: string): Config`; `type FieldSpec = { kind: "text" | "date" | "money" | "entity" | "last4"; required: boolean; prompt?: string }`; `type DocType = { describe: string; fields: Record<string, FieldSpec>; template: string; tag?: string; folder?: string | null }`; `type Config = { defaults: { date_format: string; date_order: "day-first" | "month-first"; max_name_length: number; ocr_text_layer: boolean; finder_tags: boolean; finder_comment: boolean }; models: { cheap: string; vision: string }; types: Record<string, DocType>; entities: Record<string, string[]> }`; a `package.json` declaring `@earendil-works/pi-ai` pinned at exactly `1.3.0` and `"type": "module"`; a `docnamer.yaml` carrying the full shipped roster of 15 types including `other`
- done_when: `bun test tests/config.test.ts tests/manifest.test.ts`
- Reference: `bun --version`
<!-- record:T1 -->
**done** · run `ship-feature-cd388b`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/config.test.ts tests/manifest.test.ts` passes as committed — the work shipped in an earlier run: tests/config.test.ts, tests/manifest.test.ts
<!-- /record:T1 -->

## T2: Stage 1 read ladder and fixtures
- Covers: R4, R5, I2
- Depends on: T1
- Files:
  - Create: [read.ts](../../../src/read.ts)
  - Test: [read.test.ts](../../../tests/read.test.ts)
- Interfaces:
  - Consumes: `loadConfig(path: string): Config`; `type Config`
  - Produces: `read(file: string, config: Config): Promise<Content>`; `type Content = { text: string; images: string[]; method: "text" | "ocr" | "vision"; ocrConfidence: number | null; pages: number }`; `downloadICloud(file: string): Promise<void>`; `ocrPages(pages: string[]): Promise<{ text: string; chars: number; meanConfidence: number | null }>`; a `tests/fixtures/` directory holding a text-layer PDF, a scanned PDF, a PNG image, a DOCX, a TXT, and the colliding pair of byte-identical `dup-invoice` bodies the Global Constraints name, each named so its expected type is unambiguous
- done_when: `bun test tests/read.test.ts`
- Reference: `shortcuts list`
<!-- record:T2 -->
**done** · run `ship-feature-cd388b`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/read.test.ts` passes as committed — the work shipped in an earlier run: tests/read.test.ts
<!-- /record:T2 -->

## T3: Stage 2 classify-and-extract model call
- Covers: R3, R6
- Depends on: T1, T2
- Files:
  - Create: [analyse.ts](../../../src/analyse.ts)
  - Test: [analyse.test.ts](../../../tests/analyse.test.ts)
- Interfaces:
  - Consumes: `type Config`; `type DocType`; `type Content`
  - Produces: `analyse(content: Content, fileName: string, config: Config): Promise<Analysis | Failed>`; `buildSchema(types: Record<string, DocType>): TSchema`; `type Analysis = { type: string; type_confidence: number; fields: Record<string, { value: string | null; evidence: string | null }>; summary: string }`; `type Failed = { failed: true; reason: string; raw: string }`; `isFailed(r: Analysis | Failed): r is Failed`
- done_when: `bun test tests/analyse.test.ts`
- Reference: `bun pm ls`
<!-- record:T3 -->
**done** · run `ship-feature-cd388b`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/analyse.test.ts` passes as committed — the work shipped in an earlier run: tests/analyse.test.ts
<!-- /record:T3 -->

## T4: Stage 3 validation and normalisers
- Covers: R7, R8
- Depends on: T3
- Files:
  - Create: [validate.ts](../../../src/validate.ts)
  - Test: [validate.test.ts](../../../tests/validate.test.ts)
- Interfaces:
  - Consumes: `type Analysis`; `type Failed`; `type Config`; `type Content`
  - Produces: `validate(a: Analysis, content: Content, config: Config): Checked`; `type Checked = Analysis & { flags: string[] }`; `parseDate(value: string, order: "day-first" | "month-first"): string | null`; `normaliseMoney(value: string): string`; `canonicalEntity(value: string, aliases: Record<string, string[]>): string`; `reduceLast4(value: string): string`; `retargetToOther(checked: Checked): Checked`
- done_when: `bun test tests/validate.test.ts`
- Reference: `date -j -f "%Y-%m-%d" "2026-04-03" "+%Y-%m-%d"`
<!-- record:T4 -->
**done** · run `ship-feature-cd388b`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/validate.test.ts` passes as committed — the work shipped in an earlier run: tests/validate.test.ts
<!-- /record:T4 -->

## T5: Stage 4 naming, plan command and CLI entry
- Covers: R9, R10, R11, I1, I3
- Depends on: T2, T3, T4
- Files:
  - Create: [name.ts](../../../src/name.ts)
  - Create: [commands.ts](../../../src/commands.ts)
  - Create: [cli.ts](../../../src/cli.ts)
  - Test: [name.test.ts](../../../tests/name.test.ts)
  - Test: [plan.test.ts](../../../tests/plan.test.ts)
- Interfaces:
  - Consumes: `read(file: string, config: Config): Promise<Content>`; `analyse(content: Content, fileName: string, config: Config): Promise<Analysis | Failed>`; `validate(a: Analysis, content: Content, config: Config): Checked`; `type Checked`; `type Config`
  - Produces: `buildName(checked: Checked, config: Config, file: { dir: string; ext: string }, planned: Set<string>): Promise<string>`; `sanitise(s: string): string`; `renderTemplate(t: string, fields: Record<string, string>): string`; `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `type PlanRow = { old: string; new: string; type: string; fields: Record<string, string>; evidence: Record<string, string>; flags: string[]; summary: string; size: number; mtime: number; status: "pending" | "accepted" | "skipped" }`; `writePlan(folder: string, rows: PlanRow[]): Promise<void>`; `main(argv: string[]): Promise<number>`
- done_when: `bun test tests/name.test.ts tests/plan.test.ts`
- Reference: `getconf NAME_MAX /`
<!-- record:T5 -->
**done** · run `ship-feature-cd388b`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/name.test.ts tests/plan.test.ts` passes as committed — the work shipped in an earlier run: tests/name.test.ts, tests/plan.test.ts
<!-- /record:T5 -->
<!-- record:run -->
**failed** · run `ship-feature-cd388b`
- Tasks: T1 done · T2 done · T3 done · T4 done · T5 done
- Commits: none recorded
- Detail: build: fan-out child 'part-build#1' failed: reference_decides — `bun test tests/read.test.ts` passed with its reference swapped for a wrong truth — the test's verdict does not depend on its reference; that is the test's defect, not this build's: … [+11 earlier line(s)] 8 pass 0 fail 37 expect() calls Ran 8 tests across 1 file. [1334.00ms] — and landed nothing, so it is not a hole
<!-- /record:run -->
