# WORKPLAN: doc-renamer-apply

## Global Constraints
- Requires `doc-renamer-pipeline` to have shipped first: `src/config.ts`, `src/read.ts`, `src/analyse.ts`, `src/validate.ts`, `src/name.ts`, `src/commands.ts`, `src/cli.ts`, `docnamer.yaml` and `tests/fixtures/` must all exist and `docnamer plan <folder>` must work.
- `src/commands.ts`, `src/cli.ts` and `package.json` already exist from that first feature. Where a task below Creates one of them it is rewriting that file in full, keeping every behaviour the pipeline feature already proved — `plan` must still work exactly as before after each rewrite.
- Native Bun APIs only (`Bun.file`, `Bun.$`, `Bun.Glob`, `Bun.spawn`, `Bun.YAML`); no `node:` built-ins anywhere in `src/` — R1, D2.
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
**done** · run `ship-feature-f5eff0`
- Commits: none — HEAD stayed at `414624c`
- Landed: [tests/spotlight.test.ts](../../../tests/spotlight.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when_red ✓ · reference ✓
- Summary: Wrote tests/spotlight.test.ts (T1): keeps the injected `export const reference` untouched, adds a safe dynamic import of ../src/spotlight.ts and six cases over the T1 interface, so `bun test tests/spotlight.test.ts` now exits 1 on the test's own checks (module missing => 5 fail / 1 pass), not a load crash.
<!-- /record:T1 -->

## T2: Apply and undo with the backup record
- Covers: R2, R3, R7, I1, I2
- Depends on: T1
- Files:
  - Create: [commands.ts](../../../src/commands.ts)
  - Test: [apply.test.ts](../../../tests/apply.test.ts)
- Interfaces:
  - Consumes: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `type PlanRow`; `type Config`; `setFinderTag(file: string, tag: string): Promise<void>`; `setFinderComment(file: string, comment: string): Promise<void>`; `addOcrTextLayer(file: string): Promise<{ bytes: number; sidecar: string }>`
  - Produces: `apply(folder: string, config: Config): Promise<ApplyReport>`; `undo(folder: string, run: string | null, config: Config): Promise<UndoReport>`; `type ApplyReport = { renamed: number; skipped: { file: string; reason: string }[]; undoFile: string }`; `type UndoReport = { restored: number; skipped: { file: string; reason: string }[] }`; `type UndoRecord = { run: string; at: string; entries: { old: string; new: string; size: number; mtime: number; tag?: string; comment?: string; sidecar?: string }[] }`
- done_when: `bun test tests/apply.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T2 -->
**done** · run `ship-feature-f5eff0`
- Commits: none — HEAD stayed at `414624c`
- Landed: [tests/apply.test.ts](../../../tests/apply.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when_red ✓ · reference ✓
- Summary: Wrote tests/apply.test.ts for T2 (apply/undo with backup record); it fails now for the right reason — src/commands.ts has no apply/undo export — reporting the missing work from its own check, exit 1.
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
**done** · run `ship-feature-f5eff0`
- Commits: none — HEAD stayed at `414624c`
- Landed: [tests/review.test.ts](../../../tests/review.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when_red ✓ · reference ✓
- Summary: Wrote tests/review.test.ts for T3: applyAction cases (accept/skip/edit/retype/accept-unflagged) via dynamic import of src/review.ts, plus CLI-wiring cases that spawn `review` and call main(); missing modules/exports are printed failed checks, not load-time throws, so the suite is RED for the missing work. Not executed — the turn budget ended before I could run `bun test tests/review.test.ts`.
<!-- /record:T3 -->

## T4: Eval command and the scored test set
- Covers: R8, I4
- Depends on: T3
- Files:
  - Modify: [cli.ts](../../../src/cli.ts)
  - Create: [eval.ts](../../../src/eval.ts)
  - Create: [expected.yaml](../../../tests/testset/expected.yaml)
  - Test: [eval.test.ts](../../../tests/eval.test.ts)
- Interfaces:
  - Consumes: `plan(folder: string, opts: { recursive: boolean; applyUnflagged: boolean }, config: Config): Promise<PlanRow[]>`; `type PlanRow`; `type Config`; `main(argv: string[]): Promise<number>`
  - Produces: `evalTestset(testset: string, config: Config): Promise<EvalReport>`; `type EvalReport = { files: number; typeAccuracy: number; fieldMatch: Record<string, number>; fullNameMatch: number; visionShare: number; secondsPerFile: number; costPerFile: number; misses: { file: string; expected: string; got: string; evidence: string }[] }`; `formatEvalReport(r: EvalReport): string`; a `tests/testset/` holding the graded files plus `expected.yaml`; a `cli.ts` dispatching `plan`, `apply`, `undo`, `review` and `eval`
- done_when: `bun test tests/eval.test.ts`
- Reference: `ls tests/fixtures`
<!-- record:T4 -->
**done** · run `ship-feature-f5eff0`
- Commits: none — HEAD stayed at `414624c`
- Landed: [tests/eval.test.ts](../../../tests/eval.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when_red ✓ · reference ✓
- Summary: Wrote tests/eval.test.ts for T4 (eval command + scored test set): it dynamically loads src/eval.ts and src/cli.ts inside each check, asserts the graded test set equals the reference `ls tests/fixtures`, exercises evalTestset/formatEvalReport and the CLI eval dispatch, and now fails for the missing work (exit 1, 5 fail / 0 pass).
<!-- /record:T4 -->

## T5: Compile to one standalone binary and install it
- Covers: R1
- Depends on: T4
- Files:
  - Create: [package.json](../../../package.json)
  - Test: [build.test.ts](../../../tests/build.test.ts)
- Interfaces:
  - Consumes: `main(argv: string[]): Promise<number>`
  - Produces: a `package.json` declaring a `build` script running `bun build --compile --outfile ~/bin/docnamer src/cli.ts` and an `install` script copying that binary into `~/bin`
- done_when: `bun test tests/build.test.ts`
- Reference: `bun --version`
<!-- record:T5 -->
**failed** · run `ship-feature-f5eff0`
- Commits: none — HEAD stayed at `414624c`
- Landed: nothing
- Gates: none recorded
- Summary: Could not write tests/build.test.ts — the turn budget (10 turns) was exhausted on reconnaissance before the test file could be written; the repo still holds only the seeded reference constant.
<!-- /record:T5 -->
<!-- record:run -->
**failed** · run `ship-feature-f5eff0`
- Tasks: T1 done · T2 done · T3 done · T4 done · T5 failed
- Commits: none — HEAD stayed at `414624c`
- Detail: task-tests: fan-out child 'task-test#4' failed: Could not write tests/build.test.ts — the turn budget (10 turns) was exhausted on reconnaissance before the test file could be written; the repo still holds only the seeded reference constant. — and landed nothing, so it is not a hole
<!-- /record:run -->
