/**
 * Shared e2e harness for the doc-renamer-apply feature.
 *
 * One exported function per node of INTERACTIONS.md's digraphs. A flow test is
 * its digraph's steps called in order plus the assertion of its Outcome:
 *
 *   const s = new Session()
 *   await entry(s, 'apply'); await check(s); await rename(s); await record(s); await outcome(s, 'i1')
 *
 * The four digraphs share two node names — `entry` and `outcome` — so those two
 * are the only steps that take the flow: `entry(s, flow)` prepares and runs that
 * flow's entry command, and `outcome(s, name)` asserts the terminal state of
 * whichever flow `entry` started. The other eight steps belong to one flow each.
 *
 * Each run is self-contained: a fresh temp folder, seeded fixture documents, and
 * the `docnamer` CLI resolved per run. Nothing is written into the repo outside
 * .audit/screenshots/ (the frame writer).
 *
 * The only integration surface is the CLI subprocess (decision D3): the steps
 * drive `docnamer plan|apply|undo|review|eval <folder>` and observe the plan
 * file, the undo file and the documents on disk. A step whose claim is not
 * observable from that surface throws `Skipped` — a machine-readable, non-green
 * hole — rather than passing.
 *
 * This is test code, so `node:` built-ins are fine here (R0c): the ban is on
 * `src/`, which the compiled binary ships.
 */
import { chmod, mkdir, rm } from 'node:fs/promises'
import { writePlan as persistPlan } from '../src/commands.ts'
import { CONFIG_FILE } from '../src/config.ts'
import { EXPECTED_FILE } from '../src/eval.ts'
import { appBin } from './app-binary.ts'
import { frame } from './frame.ts'
import { assertPlanCovers, base, planRows } from './plan-file.ts'
import { ensureProviderKey } from './preload.ts'

export type Flow = 'apply' | 'undo' | 'review' | 'eval'

export type PlanRow = {
  old: string
  new: string
  type: string
  method: 'text' | 'ocr' | 'vision' | null
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

export type UndoEntry = {
  old: string
  new: string
  size: number
  mtime: number
  tag?: string
  comment?: string
  sidecar?: string
}

export type UndoRecord = { run: string; at: string; entries: UndoEntry[] }

/** A named hole: the claim cannot be closed on the current observation surface. */
export class Skipped extends Error {
  readonly skip = true
  constructor(readonly claim: string) {
    super('SKIP: ' + claim)
    this.name = 'Skipped'
  }
}

/** Repo root. Exported so a spec can read the real config the harness seeds. */
export const repo = import.meta.dir.replace(/\/tests$/, '')

/** The folder's own config: Stage 1 SKIPs it, so it is never a plan row. */
export { CONFIG_FILE }

/** One seeded file is mutated after the plan is written, so `apply` must skip
 *  it and report it (R7/I1). Its name is exported so a flow can name it. */
export const CHANGED_FILE = 'changed-since-plan.txt'

/** Fixture documents seeded into every run's temp folder. */
const SEED: Array<{ name: string; body: string }> = [
  {
    name: 'invoice-acme-2026-04.txt',
    body: [
      'INVOICE',
      'Acme Ltd',
      'Invoice number: INV-0042',
      'Date: 03/04/2026',
      'Total: 482.50 GBP',
      ''
    ].join('\n')
  },
  {
    name: 'letter-hmrc.txt',
    body: ['Dear Sir,', 'A letter from HMRC dated 12 March 2026.', ''].join('\n')
  },
  {
    name: CHANGED_FILE,
    body: ['INVOICE', 'Mutated Ltd', 'Invoice number: INV-9999', 'Date: 09/09/2026', ''].join('\n')
  }
]

export class Session {
  /** Per-run working folder. */
  dir = ''
  /** `<dir>/.docnamer-plan.json`. */
  planPath = ''
  /** Latest `<dir>/.docnamer-undo-<timestamp>.json`, once a run has applied. */
  undoPath = ''
  /** Which flow `entry` started; `outcome` reads it to pick its terminal claim. */
  flow: Flow | null = null
  /** True once `runPlan` has run, so a step never re-plans over an edited file. */
  planned = false
  /** Parsed plan rows. */
  plan: PlanRow[] = []
  /** Parsed undo record, once `load` has run. */
  undo: UndoRecord | null = null
  /** The original name `restore` deliberately occupied, so undo has a skip to report. */
  blocked: string | null = null
  /** Resolved CLI argv, or null when no `docnamer` is reachable. */
  cli: string[] | null = null
  /** Last CLI invocation. */
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  /** The apply invocation, kept apart from `last` (which later steps overwrite). */
  applied: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  /** Seeded files' size and mtime, captured before `plan` runs. */
  originals = new Map<string, { size: number; mtime: number }>()
  /** The test set `run` scored, so `score` can check the report against its truth. */
  testset = ''
  booted = false
}

export async function shell(
  cmd: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The child must carry the provider key: pi-ai resolves Fireworks auth from its
  // own environment, and ensureProviderKey() sets it on THIS process. Handing the
  // environment over explicitly is what makes that reach the child.
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env } })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited
  ])
  return { code, stdout, stderr }
}

/** The one place that decides which artifact is under test. The TREE comes first:
 *  the installed bundle is whatever was built last, so preferring it tested stale
 *  code and reported the result as this tree's flow. The bundle is the fallback for
 *  a checkout with no sources, and DOCNAMER_BIN overrides both.
 *
 *  Exported because a flow that never reaches a model (tests/cli-help.test.ts, the
 *  front door) must still drive the same artifact this harness drives, not a second
 *  guess at it. */
export async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN
  if (override && override.trim()) return override.trim().split(/\s+/)
  const src = `${repo}/src/cli.ts`
  if (await Bun.file(src).exists()) return [Bun.which('bun') ?? 'bun', src]
  if (await Bun.file(appBin).exists()) return [appBin]
  return null
}

/**
 * A folder this process is not allowed to read, for the failure path. `chmod
 * 000` refuses the listing with EACCES and needs no privilege, so the test
 * needs no privacy prompt: a folder under `~/Downloads` is refused the same
 * way by macOS, only with EPERM. The mode goes back on the way out so the
 * directory can be removed.
 */
export async function closedFolder(): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-closed-${crypto.randomUUID()}`
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o000)
  return dir
}

/** Puts a `closedFolder` back to something removable. */
export async function reopen(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob('*').scan({ cwd: dir, onlyFiles: true })) out.push(rel)
  return out
}

/** Boot the isolated environment: temp folder, seeded fixtures, resolved CLI.
 *  Exported for the smoke test, which proves the harness boots a run and stays
 *  out of the repo without the program under test existing yet. */
export async function boot(s: Session): Promise<void> {
  if (s.booted) return
  await ensureProviderKey()
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-apply-${crypto.randomUUID()}`
  Bun.spawnSync(['mkdir', '-p', dir])
  s.dir = dir
  s.planPath = `${dir}/.docnamer-plan.json`
  for (const f of SEED) await Bun.write(`${dir}/${f.name}`, f.body)

  // Every fixture, copied in beside the seed files. A missing tests/fixtures is a
  // broken run, not a degraded one: swallowing the ENOENT left the flow testing the
  // hand-seeded files alone and calling it a pipeline.
  const fixtures = `${repo}/tests/fixtures`
  for await (const rel of new Bun.Glob('**/*').scan({ cwd: fixtures, onlyFiles: true })) {
    const bytes = await Bun.file(`${fixtures}/${rel}`).arrayBuffer()
    await Bun.write(`${dir}/${base(rel)}`, bytes)
  }

  // The folder's own config. docnamer.json is read from the FOLDER being planned
  // (cli.ts configFor), so without this the run falls back to the built-in
  // DEFAULT_CONFIG — a different type roster than the feature is specified against.
  const config = `${repo}/${CONFIG_FILE}`
  if (await Bun.file(config).exists()) await Bun.write(`${dir}/${CONFIG_FILE}`, Bun.file(config))

  for (const name of await listFiles(dir)) {
    const f = Bun.file(`${dir}/${name}`)
    s.originals.set(name, { size: f.size, mtime: f.lastModified })
  }
  s.cli = await resolveCli()
  s.booted = true
}

/**
 * THE PROGRAM UNDER TEST IS ABSENT, which is the RIGHT reason for a flow test to
 * be red. Only a claim the observation surface cannot see is a `Skipped`; an
 * unbuilt CLI is a failure, and the test must say so and exit non-zero itself.
 */
const missingCli = (): Error =>
  new Error(
    'docnamer CLI absent: the program under test is not built yet, so this flow is red for the right reason. Set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts'
  )

async function runCli(
  s: Session,
  argv: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!s.cli) throw missingCli()
  const res = await shell([...s.cli, ...argv])
  s.last = res
  return res
}

/** `docnamer plan <folder>`, parsed, and proved to cover what the harness seeded.
 *
 *  The plan is the expectation every later step asserts against, so it has to earn
 *  that trust first: a `plan` that silently dropped a seeded document would shrink
 *  the expectation to whatever it did return, and every step downstream would then
 *  check the product against a list the product itself produced (F6). */
async function runPlan(s: Session): Promise<void> {
  const res = await runCli(s, ['plan', s.dir])
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  const parsed = JSON.parse(await Bun.file(s.planPath).text()) as unknown
  s.plan = planRows<PlanRow>(parsed)
  s.planned = true
  assertPlanCovers(s.plan, s.originals.keys(), CONFIG_FILE)
}

/** Boot and plan if a prior step has not already done so. */
async function ensure(s: Session): Promise<void> {
  if (!s.booted) await boot(s)
  if (!s.cli) throw missingCli()
  if (!s.planned) await runPlan(s)
}

/** The latest `.docnamer-undo-<timestamp>.json` in the folder, or null. */
async function latestUndo(dir: string): Promise<string | null> {
  const found: string[] = []
  for await (const rel of new Bun.Glob('.docnamer-undo-*.json').scan({
    cwd: dir,
    onlyFiles: true
  })) {
    found.push(`${dir}/${rel}`)
  }
  found.sort()
  return found.length ? (found[found.length - 1] ?? null) : null
}

/** Plan the folder and accept every row — the state apply and undo both start from.
 *
 *  The accepted plan is written by the PRODUCT's own writer — `writePlan` in
 *  `src/commands.ts`, the same one `review` persists through — so `apply` and
 *  `undo` read a file the product produced, not one this harness hand-rolled from
 *  an envelope it had guessed (F5). */
async function acceptAll(s: Session): Promise<void> {
  await runPlan(s)
  for (const r of s.plan) r.status = 'accepted'
  await persistPlan(s.dir, s.plan)
}

/** Run `docnamer apply <folder>`, after mutating one accepted file post-plan. */
async function apply(s: Session): Promise<void> {
  // R7/I1: one accepted row's file is mutated after planning, so apply must
  // skip-and-report it rather than rename it. Appending changes size and mtime.
  const changed = `${s.dir}/${CHANGED_FILE}`
  await Bun.write(changed, (await Bun.file(changed).text()) + 'amended after planning\n')
  s.applied = await runCli(s, ['apply', s.dir])
  if (s.applied.code !== 0) {
    throw new Error(
      `docnamer apply exited ${s.applied.code}\n${s.applied.stderr}${s.applied.stdout}`
    )
  }
}

// --- entry: the four digraphs' shared entry node ------------------------------

/**
 * entry: boot and run the named flow's entry command.
 *  apply / undo — plan, accept all, then apply (undo restores from that run).
 *  review       — plan, leaving rows pending for the TUI to act on.
 *  eval         — boot only; `run` invokes `docnamer eval`.
 */
export async function entry(s: Session, flow: Flow = 'apply'): Promise<Session> {
  await boot(s)
  s.flow = flow
  if (flow === 'apply' || flow === 'undo') {
    await acceptAll(s)
    await apply(s)
  } else if (flow === 'review') {
    // `plan` already writes every row pending (`commands.ts:156`) — the state the TUI
    // acts on — so accepting and resetting them was a round trip to a file identical
    // to the one the product had just written.
    await runPlan(s)
  }
  return s
}

// --- I1: Apply accepted rows with backup --------------------------------------

/** check: verify size and mtime unchanged — the mutated file was skipped, the
 *  untouched accepted rows were not. */
export async function check(s: Session): Promise<Session> {
  await ensure(s)
  if (s.applied.code !== 0) {
    throw new Error(`apply did not run: ${s.applied.stderr}${s.applied.stdout}`)
  }
  const renamed = s.plan.filter(r => base(r.old) !== CHANGED_FILE && r.status === 'accepted')
  if (!renamed.length) throw new Skipped('I1 check: no accepted, unchanged row to verify')
  for (const r of renamed) {
    if (!(await Bun.file(`${s.dir}/${r.new}`).exists())) {
      throw new Error(`I1 check: unchanged accepted row ${r.old} was not renamed to ${r.new}`)
    }
  }
  if (await Bun.file(`${s.dir}/${CHANGED_FILE}`).exists()) {
    const report = s.applied.stdout + s.applied.stderr
    if (!report.includes(CHANGED_FILE)) {
      throw new Error(
        `I1 check: ${CHANGED_FILE} changed after planning, yet the report does not name it: ${report}`
      )
    }
  }
  return s
}

/** rename: rename in place; each renamed file keeps its bytes. */
export async function rename(s: Session): Promise<Session> {
  await ensure(s)
  for (const r of s.plan) {
    if (r.status !== 'accepted' || base(r.old) === CHANGED_FILE) continue
    if (await Bun.file(`${s.dir}/${base(r.old)}`).exists()) {
      throw new Error(`I1 rename: ${r.old} still exists after apply (rename was a copy?)`)
    }
    const f = Bun.file(`${s.dir}/${r.new}`)
    if (!(await f.exists())) throw new Error(`I1 rename: ${r.new} does not exist`)
    if (f.size === 0) throw new Error(`I1 rename: ${r.new} is empty`)
  }
  return s
}

/** record: every change is recorded in the undo file. */
export async function record(s: Session): Promise<Session> {
  await ensure(s)
  const path = await latestUndo(s.dir)
  if (!path) throw new Error('I1 record: no .docnamer-undo-<timestamp>.json was written')
  s.undoPath = path
  const rec = JSON.parse(await Bun.file(path).text()) as UndoRecord
  if (!Array.isArray(rec.entries) || rec.entries.length === 0) {
    throw new Error(`I1 record: ${path} carries no entries`)
  }
  for (const r of s.plan) {
    if (r.status !== 'accepted' || base(r.old) === CHANGED_FILE) continue
    if (!rec.entries.find(e => base(e.new) === r.new)) {
      throw new Error(`I1 record: ${r.new} is not recorded in the undo file`)
    }
  }
  return s
}

// --- I2: Undo a run ------------------------------------------------------------

/** load: load the latest `.docnamer-undo-<timestamp>.json`. */
export async function load(s: Session): Promise<Session> {
  await ensure(s)
  const path = await latestUndo(s.dir)
  if (!path) throw new Skipped('I2 load: no undo file exists yet (run apply first)')
  s.undoPath = path
  s.undo = JSON.parse(await Bun.file(path).text()) as UndoRecord
  if (!Array.isArray(s.undo.entries) || s.undo.entries.length === 0) {
    throw new Error(`I2 load: ${path} carries no entries`)
  }
  return s
}

/** restore: rename back in reverse order, no overwrites. One entry's original
 *  name is occupied first, so the run has a genuine skip to report (I2) — the
 *  happy path alone never exercises that branch. */
export async function restore(s: Session): Promise<Session> {
  await ensure(s)
  if (!s.undo) await load(s)
  const blocked = s.undo?.entries.find(e => e.old !== e.new)
  if (blocked) {
    // The occupant is what makes undo skip: it must not be overwritten (I2).
    await Bun.write(`${s.dir}/${blocked.old}`, 'occupant\n')
    s.blocked = blocked.old
  }
  const res = await runCli(s, ['undo', s.dir])
  if (res.code !== 0) {
    throw new Error(`docnamer undo exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  for (const e of s.undo?.entries ?? []) {
    if (e.old === s.blocked) continue
    if (await Bun.file(`${s.dir}/${e.new}`).exists()) {
      throw new Error(`I2 restore: new name ${e.new} still exists after undo`)
    }
  }
  // The blocked entry was never renamed back, so the loop above skips it — which
  // left nothing asserting it kept its new name. An undo that deleted it, or moved
  // it somewhere third, passed.
  const kept = s.undo?.entries.find(e => e.old === s.blocked)
  if (kept && !(await Bun.file(`${s.dir}/${kept.new}`).exists())) {
    throw new Error(`I2 restore: the blocked entry's new name ${kept.new} did not survive undo`)
  }
  return s
}

// --- I3: Review and accept plan rows -------------------------------------------

/** act: run a review action against the plan file. The TUI reads its keys from
 *  stdin; `A` accepts every unflagged row while flagged rows stay pending. No
 *  trailing newline: a bare Enter is itself the accept key (R4/I3), so `A\n`
 *  would accept one row after the sweep. */
export async function act(s: Session, keys = 'A'): Promise<Session> {
  await ensure(s)
  if (!s.cli) throw missingCli()
  const p = Bun.spawn([...s.cli, 'review', s.dir], {
    stdin: new Blob([keys]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...Bun.env }
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited
  ])
  s.last = { code, stdout, stderr }
  if (code !== 0) throw new Error(`docnamer review exited ${code}\n${stderr}${stdout}`)
  s.plan = planRows<PlanRow>(JSON.parse(await Bun.file(s.planPath).text()) as unknown)
  return s
}

// --- I4: Score a test set with eval --------------------------------------------

/**
 * The set I4's frame is captured from: the committed one, copied, with ONE file's
 * expected type mis-stated so the run has a miss to show.
 *
 * The committed set is tuned so the model gets every file right, and a report that
 * prints "misses: none" shows a person neither the expected-vs-got pair nor the
 * evidence beside it — the whole of what I4's frame exists to demonstrate. Nothing
 * is fabricated: the report is the renderer's own output over a real
 * `docnamer eval` run, and only the truth it is scored against is deliberately
 * wrong in one place — which is what a real test set with a hard file does too.
 */
export async function missTestset(): Promise<string> {
  const from = `${repo}/tests/testset`
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-miss-${crypto.randomUUID()}`
  await mkdir(dir, { recursive: true })
  for (const rel of await listFiles(from)) {
    await Bun.write(`${dir}/${rel}`, Bun.file(`${from}/${rel}`))
  }
  const truth = `${dir}/${EXPECTED_FILE}`
  // The truth file is JSON, so the mis-statement is made on the parsed object. The
  // YAML-shaped `type: letter` this used to search for appears nowhere in the file,
  // so the string replace matched nothing and threw before any model ran.
  const expected = JSON.parse(await Bun.file(truth).text()) as Record<string, { type?: string }>
  const letter = Object.keys(expected).find(f => expected[f]?.type === 'letter')
  if (!letter) {
    throw new Error(`missTestset: ${truth} states no file of type "letter" to mis-state`)
  }
  expected[letter]!.type = 'receipt'
  await Bun.write(truth, `${JSON.stringify(expected, null, 2)}\n`)
  return dir
}

/** run: run Stages 1-4 against the test set without renaming anything. */
export async function run(s: Session, testset?: string): Promise<Session> {
  await boot(s)
  const target = testset ?? `${repo}/tests/testset`
  s.testset = target
  const res = await runCli(s, ['eval', target])
  if (res.code !== 0)
    throw new Error(`docnamer eval exited ${res.code}\n${res.stderr}${res.stdout}`)
  // Nothing was renamed: every seeded file still sits at its original name.
  for (const [n] of s.originals) {
    if (n === CONFIG_FILE) continue
    if (!(await Bun.file(`${s.dir}/${n}`).exists())) {
      throw new Error(`I4 run: ${n} disappeared; eval must not rename anything`)
    }
  }
  return s
}

/** One metric's value, read off its own line, or a throw naming the line that is
 *  missing. A report that merely mentions the word does not answer this. */
function metric(out: string, label: string, pattern: RegExp): number {
  const m = new RegExp(`^${label}\\s*${pattern.source}`, 'm').exec(out)
  if (!m) throw new Error(`I4 score: the report carries no "${label}" line:\n${out}`)
  return Number(m[1])
}

/** score: read every metric off the report and check it against the truth it was
 *  scored against. The accuracy the report prints must be the same arithmetic as
 *  the misses it prints beside it — counted here, not taken from the product. */
export async function score(s: Session): Promise<Session> {
  const out = s.last.stdout
  const files = metric(out, 'eval report:', /(\d+) file/)
  const type = metric(out, 'type accuracy:', /([\d.]+)%/)
  const full = metric(out, 'full name match:', /([\d.]+)%/)
  const vision = metric(out, 'vision share:', /([\d.]+)%/)
  const seconds = metric(out, 'time per file:', /([\d.]+)s/)
  const cost = metric(out, 'cost per file:', /\$([\d.]+)/)

  const expected = JSON.parse(await Bun.file(`${s.testset}/${EXPECTED_FILE}`).text()) as Record<
    string,
    { type?: string }
  >
  const graded = Object.keys(expected).length
  if (files !== graded) {
    throw new Error(
      `I4 score: the report scored ${files} file(s); ${s.testset} grades ${graded}:\n${out}`
    )
  }

  // A wrong type is the one miss the report spells `type: expected ...`, and the
  // product divides its type hits by every graded file — so the accuracy it printed
  // is (typed - wrongType) / files, which this recomputes from the printed block.
  const wrongType = (out.match(/type: expected /g) ?? []).length
  const typed = Object.values(expected).filter(e => e.type !== undefined).length
  const accuracy = ((typed - wrongType) / graded) * 100
  if (Math.abs(type - accuracy) > 0.05) {
    throw new Error(
      `I4 score: the report says ${type}% type accuracy, but ${wrongType} of ${typed} typed file(s) missed — ${accuracy.toFixed(1)}%:\n${out}`
    )
  }
  const declared = metric(out, 'misses', /\((\d+)\)/)
  const shown = (out.match(/^ {4}expected: /gm) ?? []).length
  if (declared !== shown) {
    throw new Error(
      `I4 score: the report announces ${declared} miss(es) and shows ${shown}:\n${out}`
    )
  }

  for (const [label, value] of [
    ['type accuracy', type],
    ['full name match', full],
    ['vision share', vision]
  ] as const) {
    if (!(value >= 0 && value <= 100)) {
      throw new Error(`I4 score: ${label} is ${value}%, which is not a percentage:\n${out}`)
    }
  }
  if (!(seconds > 0)) {
    throw new Error(`I4 score: time per file is ${seconds}s, which is no measurement:\n${out}`)
  }
  // src/eval.ts cannot compute a dollar figure — plan() surfaces no per-call token
  // usage, so the report carries 0 rather than a guess. A non-zero cost means that
  // changed, and this line must then assert the real number instead.
  if (cost !== 0) {
    throw new Error(`I4 score: cost per file is $${cost}, and nothing computes one yet:\n${out}`)
  }
  return s
}

// --- outcome: the four digraphs' shared terminal node -------------------------

/**
 * outcome: assert the terminal state of the flow `entry` started, and write the
 * flow's frame.
 *  apply  — files renamed; undo file saved; plan deleted.
 *  undo   — original names restored; the summary names each restored file and
 *           reports the skip with its reason; undo file deleted.
 *  review — row statuses updated in the plan file.
 *  eval   — accuracy metrics and side-by-side misses printed.
 */
export async function outcome(s: Session, name: string): Promise<Session> {
  const flow = s.flow ?? 'apply'
  // eval's report is `run`'s stdout in `last`. Planning here would overwrite it
  // with a plan table, and then the misses would be looked for in the wrong text.
  if (flow === 'eval') {
    const out = s.last.stdout
    // I4's whole point is a miss a person can read: the report pairs the value it
    // expected with the one it got and prints the evidence behind it. A frame that
    // says "misses: none" demonstrates none of that, so the flow scores a test set
    // built with a miss in it and the frame must carry the block.
    if (!/misses\s*\(/i.test(out)) {
      throw new Error(
        `I4 outcome: the report shows no miss, so nothing demonstrates expected-vs-got:\n${out}`
      )
    }
    if (!(/expected/i.test(out) && /got/i.test(out) && /evidence/i.test(out))) {
      throw new Error(
        `I4 outcome: the miss is not shown expected-vs-got with its evidence:\n${out}`
      )
    }
    await frame(out, name)
    return s
  }
  await ensure(s)
  if (flow === 'apply') {
    if (await Bun.file(s.planPath).exists()) {
      throw new Error('I1 outcome: the plan file was not deleted after apply')
    }
    if (!(await latestUndo(s.dir))) throw new Error('I1 outcome: no undo file was saved')
    await frame(s.applied.stdout || s.last.stdout, name)
  } else if (flow === 'undo') {
    for (const e of s.undo?.entries ?? []) {
      if (!(await Bun.file(`${s.dir}/${e.old}`).exists())) {
        throw new Error(`I2 outcome: original name ${e.old} was not restored`)
      }
    }
    if (await latestUndo(s.dir)) throw new Error('I2 outcome: the undo file was not deleted')
    // I2: the summary names every file it put back and reports each entry it
    // could not, with the reason. A count alone leaves a person unable to tell
    // which file is where after an operation whose whole point is reversibility.
    const out = s.last.stdout
    for (const e of s.undo?.entries ?? []) {
      if (e.old === s.blocked) continue
      if (!out.includes(e.old)) {
        throw new Error(`I2 outcome: the summary does not name the restored ${e.old}:\n${out}`)
      }
    }
    if (s.blocked && !out.includes(`skipped ${s.blocked}: original name is occupied`)) {
      throw new Error(
        `I2 outcome: the summary does not report the skipped ${s.blocked} with its reason:\n${out}`
      )
    }
    await frame(s.last.stdout, name)
  } else if (flow === 'review') {
    if (!s.plan.length) throw new Error('I3 outcome: the plan file has no rows after review')
    for (const r of s.plan) {
      if (r.flags.length === 0 && r.status !== 'accepted') {
        throw new Error(`I3 outcome: unflagged row ${r.old} is ${r.status}, not accepted`)
      }
      if (r.flags.length > 0 && r.status === 'accepted') {
        throw new Error(`I3 outcome: flagged row ${r.old} was accepted by "accept all unflagged"`)
      }
    }
    await frame(s.last.stdout, name)
  }
  return s
}
