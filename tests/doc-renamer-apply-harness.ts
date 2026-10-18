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
 * Native Bun APIs only; no `node:` built-ins (D2).
 */
import { frame } from './frame.ts'
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
export const CONFIG_FILE = 'docnamer.yaml'

/** One seeded file is mutated after the plan is written, so `apply` must skip
 *  it and report it (R7/I1). Its name is exported so a flow can name it. */
export const CHANGED_FILE = 'changed-since-plan.txt'

function base(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] ?? p
}

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
  /** The plan file's raw JSON envelope, so a write-back preserves its shape. */
  planRaw: unknown = null
  /** Parsed plan rows. */
  plan: PlanRow[] = []
  /** Parsed undo record, once `load` has run. */
  undo: UndoRecord | null = null
  /** Resolved CLI argv, or null when no `docnamer` is reachable. */
  cli: string[] | null = null
  /** Last CLI invocation. */
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  /** The apply invocation, kept apart from `last` (which later steps overwrite). */
  applied: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  /** Seeded files' size and mtime, captured before `plan` runs. */
  originals = new Map<string, { size: number; mtime: number }>()
  booted = false
}

async function shell(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN
  if (override && override.trim()) return override.trim().split(/\s+/)
  const onPath = Bun.which('docnamer')
  if (onPath) return [onPath]
  const src = `${repo}/src/cli.ts`
  if (await Bun.file(src).exists()) return [Bun.which('bun') ?? 'bun', src]
  return null
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

  // A real fixture set, when one exists, is copied in beside the seed files.
  const fixtures = `${repo}/tests/fixtures`
  try {
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: fixtures, onlyFiles: true })) {
      const bytes = await Bun.file(`${fixtures}/${rel}`).arrayBuffer()
      await Bun.write(`${dir}/${base(rel)}`, bytes)
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }

  // The folder's own config. docnamer.yaml is read from the FOLDER being planned
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

/** `docnamer plan <folder>`, parsed, keeping the file's raw envelope. */
async function runPlan(s: Session): Promise<void> {
  const res = await runCli(s, ['plan', s.dir])
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  const parsed = JSON.parse(await Bun.file(s.planPath).text()) as unknown
  s.planRaw = parsed
  s.plan = Array.isArray(parsed)
    ? (parsed as PlanRow[])
    : ((parsed as { rows?: PlanRow[]; files?: PlanRow[] }).rows ??
      (parsed as { files?: PlanRow[] }).files ??
      [])
}

/** Write `s.plan` back into the plan file, preserving the envelope it arrived in. */
async function writePlan(s: Session): Promise<void> {
  const raw = s.planRaw
  let out: unknown = s.plan
  if (raw && !Array.isArray(raw)) {
    if ('rows' in (raw as object)) out = { ...(raw as object), rows: s.plan }
    else if ('files' in (raw as object)) out = { ...(raw as object), files: s.plan }
  }
  await Bun.write(s.planPath, JSON.stringify(out, null, 2))
}

/** Boot and plan if a prior step has not already done so. */
async function ensure(s: Session): Promise<void> {
  if (!s.booted) await boot(s)
  if (!s.cli) throw missingCli()
  if (!s.planRaw) await runPlan(s)
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

/** Plan the folder and accept every row — the state apply and undo both start from. */
async function acceptAll(s: Session): Promise<void> {
  await runPlan(s)
  for (const r of s.plan) r.status = 'accepted'
  await writePlan(s)
}

/** Run `docnamer apply <folder>`, after mutating one accepted file post-plan. */
async function apply(s: Session): Promise<void> {
  // R7/I1: one accepted row's file is mutated after planning, so apply must
  // skip-and-report it rather than rename it. Appending changes size and mtime.
  const changed = `${s.dir}/${CHANGED_FILE}`
  await Bun.write(changed, (await Bun.file(changed).text()) + 'amended after planning\n')
  s.applied = await runCli(s, ['apply', s.dir])
  if (s.applied.code !== 0) {
    throw new Error(`docnamer apply exited ${s.applied.code}\n${s.applied.stderr}${s.applied.stdout}`)
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
    await acceptAll(s)
    for (const r of s.plan) r.status = 'pending'
    await writePlan(s)
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

/** restore: rename back in reverse order, no overwrites. */
export async function restore(s: Session): Promise<Session> {
  await ensure(s)
  if (!s.undo) await load(s)
  const res = await runCli(s, ['undo', s.dir])
  if (res.code !== 0) {
    throw new Error(`docnamer undo exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  for (const e of s.undo?.entries ?? []) {
    if (await Bun.file(`${s.dir}/${e.new}`).exists()) {
      throw new Error(`I2 restore: new name ${e.new} still exists after undo`)
    }
  }
  return s
}

// --- I3: Review and accept plan rows -------------------------------------------

/** act: run a review action against the plan file. The TUI reads its keys from
 *  stdin; `A` accepts every unflagged row while flagged rows stay pending. */
export async function act(s: Session, keys = 'A\n'): Promise<Session> {
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
  const parsed = JSON.parse(await Bun.file(s.planPath).text()) as unknown
  s.plan = Array.isArray(parsed)
    ? (parsed as PlanRow[])
    : ((parsed as { rows?: PlanRow[] }).rows ?? [])
  return s
}

// --- I4: Score a test set with eval --------------------------------------------

/** run: run Stages 1-4 against the test set without renaming anything. */
export async function run(s: Session, testset?: string): Promise<Session> {
  await boot(s)
  const target = testset ?? `${repo}/tests/testset`
  const res = await runCli(s, ['eval', target])
  if (res.code !== 0) throw new Error(`docnamer eval exited ${res.code}\n${res.stderr}${res.stdout}`)
  // Nothing was renamed: every seeded file still sits at its original name.
  for (const [n] of s.originals) {
    if (n === CONFIG_FILE) continue
    if (!(await Bun.file(`${s.dir}/${n}`).exists())) {
      throw new Error(`I4 run: ${n} disappeared; eval must not rename anything`)
    }
  }
  return s
}

/** score: compare against expected.yaml — accuracy metrics printed. */
export async function score(s: Session): Promise<Session> {
  const out = s.last.stdout
  for (const metric of ['type', 'field', 'full', 'vision', 'cost']) {
    if (!out.toLowerCase().includes(metric)) {
      throw new Error(`I4 score: the report carries no ${metric} metric:\n${out}`)
    }
  }
  return s
}

// --- outcome: the four digraphs' shared terminal node -------------------------

/**
 * outcome: assert the terminal state of the flow `entry` started, and write the
 * flow's frame.
 *  apply  — files renamed; undo file saved; plan deleted.
 *  undo   — original names restored; undo file deleted.
 *  review — row statuses updated in the plan file.
 *  eval   — accuracy metrics and side-by-side misses printed.
 */
export async function outcome(s: Session, name: string): Promise<Session> {
  await ensure(s)
  const flow = s.flow ?? 'apply'
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
  } else {
    const out = s.last.stdout
    if (!/expected/i.test(out) || !/got/i.test(out)) {
      throw new Error(`I4 outcome: misses are not shown expected-vs-got:\n${out}`)
    }
    await frame(out, name)
  }
  return s
}
