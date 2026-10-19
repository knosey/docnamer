# WORKPLAN: doc-renamer-apply

## Global Constraints
- Requires `doc-renamer-pipeline` to have shipped first: `src/config.ts`, `src/read.ts`, `src/analyse.ts`, `src/validate.ts`, `src/name.ts`, `src/commands.ts`, `src/cli.ts`, `docnamer.json` and `tests/fixtures/` must all exist and `docnamer plan <folder>` must work.
- `src/commands.ts`, `src/cli.ts` and `package.json` already exist from that first feature. Where a task below Creates one of them it is rewriting that file in full, keeping every behaviour the pipeline feature already proved — `plan` must still work exactly as before after each rewrite.
- Native Bun APIs only (`Bun.file`, `Bun.$`, `Bun.Glob`, `Bun.spawn`); no `node:` built-ins anywhere in `src/` — R1, D2.
- All model calls go through `@earendil-works/pi-ai` version 1.3.0; no hand-rolled provider HTTP layer — D4.
- `docnamer <command> <folder>` is the entire integration surface; no importable library API — D3.
- Nothing is renamed, moved or rewritten without an accepted plan row; every mutation is recorded in an undo file — R2, R3, R7.
- Every undo record is plain JSON; original bytes needed for restore live in a sidecar copy named by that JSON, never inside it — R3, R5.
- Process termination is SIGTERM, never SIGKILL.

## Setup
- `mkdir -p ~/bin`

## T1: Spotlight extras — Finder tags, comments and the OCR text layer
- Covers: R5, R6
- Depends on: none
- Files:
  - Create: [spotlight.ts](../../../src/spotlight.ts)
  - Test: [spotlight.test.ts](../../../tests/spotlight.test.ts)
- Interfaces:
  - Consumes: `type Config`
  - Produces: `setFinderTag(file: string, tag: string): Promise<void>`; `readFinderTags(file: string): Promise<string[]>`; `setFinderComment(file: string, comment: string): Promise<void>`; `addOcrTextLayer(file: string): Promise<{ bytes: number; sidecar: string }>`; `encodeTagPlist(tags: string[]): Uint8Array`; `decodeTagPlist(bytes: Uint8Array): string[]`
- done_when: `bun test tests/spotlight.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T1 -->
**done** · run `ship-feature-14767a`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/spotlight.test.ts` passes as committed — the work shipped in an earlier run: tests/spotlight.test.ts
<!-- /record:T1 -->

## T2: Apply and undo with the backup record
- Covers: R2, R3, R7, I1, I2
- Depends on: T1
- Files:
  - Create: [commands.ts](../../../src/commands.ts)
  - Test: [apply.test.ts](../../../tests/apply.test.ts)
- Interfaces:
  - Consumes: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `type PlanRow`; `type Config`; `setFinderTag(file: string, tag: string): Promise<void>`; `setFinderComment(file: string, comment: string): Promise<void>`; `addOcrTextLayer(file: string): Promise<{ bytes: number; sidecar: string }>`
  - Produces: `apply(folder: string, config: Config): Promise<ApplyReport>`; `undo(folder: string, run: string | null, config: Config): Promise<UndoReport>`; `type ApplyReport = { renamed: number; skipped: { file: string; reason: string }[]; undoFile: string }`; `type UndoReport = { restored: string[]; skipped: { file: string; reason: string }[] }`; `type UndoRecord = { run: string; at: string; entries: { old: string; new: string; size: number; mtime: number; tag?: string; comment?: string; sidecar?: string }[] }`
- done_when: `bun test tests/apply.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T2 -->
**done** · run `ship-feature-14767a`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/apply.test.ts` passes as committed — the work shipped in an earlier run: tests/apply.test.ts
<!-- /record:T2 -->

## T3: Review TUI and its CLI wiring
- Covers: R4, I3
- Depends on: T2
- Files:
  - Create: [cli.ts](../../../src/cli.ts)
  - Create: [review.ts](../../../src/review.ts)
  - Test: [review.test.ts](../../../tests/review.test.ts)
- Interfaces:
  - Consumes: `type PlanRow`; `type Config`; `buildName(checked: Checked, config: Config, file: { dir: string; ext: string }, planned: Set<string>): Promise<string>`; `writePlan(folder: string, rows: PlanRow[]): Promise<void>`; `main(argv: string[]): Promise<number>`
  - Produces: `review(folder: string, config: Config): Promise<void>`; `type ReviewAction = "accept" | "edit" | "retype" | "skip" | "accept-unflagged"`; `applyAction(rows: PlanRow[], index: number, action: ReviewAction, value: string | null, config: Config): Promise<PlanRow[]>`; a `cli.ts` dispatching `plan`, `apply`, `undo` and `review`
- done_when: `bun test tests/review.test.ts`
- Reference: `bun --version`
<!-- record:T3 -->
**done** · run `ship-feature-14767a`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/review.test.ts` passes as committed — the work shipped in an earlier run: tests/review.test.ts
<!-- /record:T3 -->

## T4: Eval command and the scored test set
- Covers: R8, I4
- Depends on: T3
- Files:
  - Modify: [cli.ts](../../../src/cli.ts)
  - Create: [eval.ts](../../../src/eval.ts)
  - Create: [expected.json](../../../tests/testset/expected.json)
  - Test: [eval.test.ts](../../../tests/eval.test.ts)
- Interfaces:
  - Consumes: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `type PlanRow`; `type Config`; `main(argv: string[]): Promise<number>`
  - Produces: `evalTestset(testset: string, config: Config): Promise<EvalReport>`; `type EvalReport = { files: number; typeAccuracy: number; fieldMatch: Record<string, number>; fullNameMatch: number; visionShare: number; secondsPerFile: number; costPerFile: number; misses: { file: string; expected: string; got: string; evidence: string }[] }`; `formatEvalReport(r: EvalReport): string`; a `tests/testset/` holding the graded files plus `expected.json`; a `cli.ts` dispatching `plan`, `apply`, `undo`, `review` and `eval`
- done_when: `bun test tests/eval.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T4 -->
**done** · run `ship-feature-14767a`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/eval.test.ts` passes as committed — the work shipped in an earlier run: tests/eval.test.ts
<!-- /record:T4 -->

## T5: Compile to one standalone binary and install it
- Covers: R1
- Depends on: T4
- Files:
  - Create: [package.json](../../../package.json)
  - Modify: [read.ts](../../../src/read.ts)
  - Test: [build.test.ts](../../../tests/build.test.ts)
- Interfaces:
  - Consumes: `main(argv: string[]): Promise<number>`
  - Produces: a `package.json` declaring `build` as `mkdir -p ~/bin && bun build --compile --outfile ~/bin/docnamer src/cli.ts` and `install` as `bun run build`; a `read.ts` whose `macOcrBinary()` resolves only the copy embedded in the binary — never `mac-ocr` on PATH, which under the R1 ~/bin install is the user's global install the BRIEF forbids — unpacking it — `import macOcr from '../node_modules/mac-ocr/bin/mac-ocr' with { type: 'file' }` together with `import macOcrPkg from '../node_modules/mac-ocr/package.json'` — to `${Bun.env.TMPDIR}/docnamer-mac-ocr-${macOcrPkg.version}`, throwing when `TMPDIR` is unset (R2: never a fallback); a compiled binary's own asset path is Bun's virtual `/$bunfs/...`, which cannot be exec'd, so the unpack writes with `Bun.write(dest, Bun.file(macOcr))` and then runs `Bun.spawnSync(['chmod', '755', dest])` — Bun exposes no chmod API, and `Bun.write`'s `mode` option is silently IGNORED inside a compiled binary (verified on bun 1.4.2: `mode: 0o755` yields 0644 compiled against 0755 uncompiled), so the chmod is not optional — reusing the file when it already exists only after it hashes to the pin — the embedded bytes are byte-identical to `node_modules/mac-ocr/bin/mac-ocr` (sha256 `1817fff474a88706104167f8f47983ecea93a3b41cd10fa6b8585c026ffd7668`, verified at unpack time and on every TMPDIR reuse, and the unpacked copy runs `--version` → `1.2.1`); a `tests/build.test.ts` asserting (a) `bun run build` exits 0 and `~/bin/docnamer` exists and is executable, (b) `BUN_BE_BUN=1 ~/bin/docnamer --version` prints exactly what the Reference prints, (c) no `node:` built-in is imported anywhere in `src/` — `bun build --compile` succeeds with them, so this scan is the only enforcement of the Global Constraint, and (d) that same binary plans a fresh temp folder holding `tests/fixtures/acme-statement-scan.pdf` and a copy of the repo's own `docnamer.json` — exit 0, exactly one row, `row.type !== "other"`, and no flag containing `mac-ocr`, because a compiled binary that cannot reach mac-ocr degrades every scan to `other` carrying that flag, which is the whole reason this assertion exists
- done_when: `bun test tests/build.test.ts`
- Reference: `bun --version`
<!-- record:T5 -->
**done** · run `ship-feature-14767a`
- Commits: none recorded
- Landed: nothing
- Gates: reference ✓
- Summary: RE-RUN, ALREADY GREEN: `bun test tests/build.test.ts` passes as committed — the work shipped in an earlier run: tests/build.test.ts
<!-- /record:T5 -->
<!-- record:run -->
**success** · run `ship-feature-14767a`
- Tasks: T1 done · T2 done · T3 done · T4 done · T5 done
- Commits: none recorded
- Detail: every node succeeded
<!-- /record:run -->
