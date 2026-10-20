/**
 * Shared e2e harness for the doc-renamer-pipeline feature: one exported function per node of
 * INTERACTIONS.md's digraphs, so a flow test is its digraph's steps in order plus its Outcome:
 *
 *   const s = new Session();
 *   await entry(s); await read(s); await analyse(s); await name(s); await outcome(s);
 *
 * Each run is self-contained: a fresh temp folder, seeded fixture documents, and the `docnamer` CLI
 * resolved per run. Nothing is written into the repo.
 *
 * The only integration surface is the CLI subprocess: the steps drive `docnamer plan <folder>` and
 * observe `.docnamer-plan.json` and the originals on disk. A step whose claim that surface cannot
 * show throws `Skipped` — a machine-readable, non-green hole — rather than passing.
 *
 * Native Bun APIs only; no `node:` built-ins.
 */
import { CONFIG_FILE } from '../src/config.ts'
import { appBin } from './app-binary.ts'
import { frame } from './frame.ts'
import { assertPlanCovers, base, planRows } from './plan-file.ts'
import { ensureProviderKey } from './preload.ts'

export type PlanRow = {
  old: string
  new: string
  type: string
  /** Which rung of Stage 1's ladder fed Stage 2 (I2); null when the read failed. */
  method: 'text' | 'ocr' | 'vision' | null
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

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

/**
 * Two documents, byte-identical: same type and same extracted field values, so
 * Stage 4 renders the same stem for both. Their extensions differ (`.txt`,
 * `.md`) and Stage 4 keeps each file's own extension, so these two do NOT
 * collide — they prove the extension is part of the name. The body is
 * deliberately not the seed invoice's, so only this pair shares its content.
 */
const DUP_INVOICE = [
  'INVOICE',
  'Northwind Traders',
  'Invoice number: INV-0777',
  'Date: 11/04/2026',
  'Total: 129.00 GBP',
  ''
].join('\n')

/**
 * A page OCR cannot read, and the only route to the vision rung: read.ts falls
 * through to the vision model only when OCR finds no glyphs (meanConfidence
 * null) or reads them under OCR_MIN_CONFIDENCE. Built at boot by resampling a
 * real fixture to 12x12 — too small to hold a legible glyph — because a
 * committed binary cannot pass the tree's copy-into-tree guard.
 */
const NO_TEXT_FIXTURE = 'unreadable-scan.pdf'

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
  { name: 'dup-invoice.txt', body: DUP_INVOICE },
  { name: 'dup-invoice.md', body: DUP_INVOICE }
]

export class Session {
  /** Per-run working folder. */
  dir = ''
  /** `<dir>/.docnamer-plan.json`. */
  planPath = ''
  /** Parsed plan rows. */
  plan: PlanRow[] = []
  /** Resolved CLI argv, or null when no `docnamer` is reachable. */
  cli: string[] | null = null
  /** Last CLI invocation. */
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  /** Seeded files' size and mtime, captured before `plan` runs. */
  originals = new Map<string, { size: number; mtime: number }>()
  booted = false
}

async function shell(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // The child must carry the provider key: pi-ai resolves Fireworks auth from its
  // own environment, and ensureProviderKey() sets it on THIS process. Handing the
  // environment over explicitly is what makes that reach the child; relying on
  // inheritance left every analyse call with no key, which failed in ~0.1s per
  // file with "returned no parseable JSON analysis" and no model ever called.
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env } })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited
  ])
  return { code, stdout, stderr }
}

/** Same order as the apply harness, for the same reason: the tree is the code under
 *  test, the installed bundle is only a fallback for a checkout with no sources. */
async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN
  if (override && override.trim()) return override.trim().split(/\s+/)
  const src = `${repo}/src/cli.ts`
  if (await Bun.file(src).exists()) return [Bun.which('bun') ?? 'bun', src]
  if (await Bun.file(appBin).exists()) return [appBin]
  return null
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob('*').scan({ cwd: dir, onlyFiles: true })) out.push(rel)
  return out
}

/** Boot the isolated environment: temp folder, seeded fixtures, resolved CLI.
 *  Exported for the smoke test, which proves the harness boots a run and stays out of the repo. */
export async function boot(s: Session): Promise<void> {
  if (s.booted) return
  await ensureProviderKey()
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-${crypto.randomUUID()}`
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
  // DEFAULT_CONFIG — a different type roster, and a vision model this machine
  // cannot call. The feature is specified against the repo's config.
  const config = `${repo}/${CONFIG_FILE}`
  if (await Bun.file(config).exists()) await Bun.write(`${dir}/${CONFIG_FILE}`, Bun.file(config))

  const receipt = `${dir}/receipt.png`
  if (await Bun.file(receipt).exists()) {
    const proc = Bun.spawnSync([
      'sips',
      '-s',
      'format',
      'pdf',
      '--resampleHeightWidth',
      '12',
      '12',
      receipt,
      '--out',
      `${dir}/${NO_TEXT_FIXTURE}`
    ])
    if (proc.exitCode !== 0) {
      throw new Error(
        `boot: sips could not build ${NO_TEXT_FIXTURE}: ${proc.stderr.toString().trim()}`
      )
    }
  }

  for (const name of await listFiles(dir)) {
    const f = Bun.file(`${dir}/${name}`)
    s.originals.set(name, { size: f.size, mtime: f.lastModified })
  }
  s.cli = await resolveCli()
  s.booted = true
}

/** Run `docnamer plan <folder>` and parse the plan file. */
/**
 * The program under test being absent is the RIGHT reason for a flow test to be red, so this is a
 * failure and not a `Skipped`: only a claim the observation surface cannot see is a `Skipped`, an
 * unbuilt CLI is a failure.
 */
const missingCli = (): Error =>
  new Error(
    'docnamer CLI absent: the program under test is not built yet, so this flow is red for the right reason. Set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts'
  )

async function runPlan(s: Session): Promise<void> {
  if (!s.cli) throw missingCli()
  const res = await shell([...s.cli, 'plan', s.dir])
  s.last = res
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  const parsed = JSON.parse(await Bun.file(s.planPath).text()) as unknown
  s.plan = planRows<PlanRow>(parsed)
}

/** Boot and plan if a prior step has not already done so. */
async function ensure(s: Session): Promise<void> {
  if (!s.booted) await boot(s)
  if (!s.cli) throw missingCli()
  if (s.last.code !== 0) await runPlan(s)
}

// --- I1: Plan a folder of documents without touching files --------------------

/** entry: boot the environment and run `docnamer plan <folder>`. */
export async function entry(s: Session): Promise<Session> {
  await boot(s)
  await runPlan(s)
  return s
}

/** read: Stage 1 — every seeded file reached the plan as a row. */
export async function read(s: Session): Promise<Session> {
  await ensure(s)
  assertPlanCovers(s.plan, s.originals.keys(), CONFIG_FILE)
  return s
}

/** analyse: Stages 2-3 — each row carries a type and a summary. */
export async function analyse(s: Session): Promise<Session> {
  await ensure(s)
  for (const r of s.plan) {
    if (!r.type) throw new Error(`Stage 2 analyse produced no type for ${r.old}`)
    if (!r.summary) throw new Error(`Stage 2 analyse produced no summary for ${r.old}`)
  }
  return s
}

/** Alphanumerics only, uppercased — the form a value and a name both reduce to. */
function flat(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Does the rendered name CARRY this extracted value? Not a substring test: the
 * name is sanitised, and a date is reformatted rather than copied, so compare the
 * value's LONGEST token against the flattened name — the longest, because a
 * one-character token matches almost any name and would make the guard vacuous.
 *
 * `null` means the value holds nothing alphanumeric to look for (a dash, a slash),
 * so no claim can be made about it. It used to return `true` for that case AND for
 * every token over 20 characters, which waived the guard for the class of value the
 * feature exists to preserve; the caller counts those waivers and fails on them.
 */
function carries(name: string, value: string): boolean | null {
  let longest = ''
  for (const t of value.split(/[^A-Za-z0-9]+/)) if (t.length > longest.length) longest = t
  if (!longest) return null
  return flat(name).includes(flat(longest))
}

/** The extracted values of one row that the rendered name does NOT carry. Throws on
 *  the first one it finds: a name that drops a value it extracted is the regression
 *  this stage exists to catch.
 *
 *  Values with nothing alphanumeric in them are RETURNED rather than thrown — the
 *  caller reports them as holes, because a guard that silently passes on the values
 *  it cannot look for is the guard that was missing. */
function fieldsDropped(r: PlanRow): string[] {
  const waived: string[] = []
  // `date` is excluded: the template REFORMATS it (03/04/2026 -> 2026-04-03),
  // so its tokens need not survive verbatim.
  for (const [field, value] of Object.entries(r.fields)) {
    if (!value || field === 'date') continue
    const carried = carries(r.new, value)
    if (carried === true) continue
    if (carried === null) {
      waived.push(`${field} ${JSON.stringify(value)}`)
      continue
    }
    throw new Error(
      `Stage 4 name drops ${r.old}'s ${field} ${JSON.stringify(value)}: ${JSON.stringify(r.new)}`
    )
  }
  return waived
}

/** name: Stage 4 — each row proposes a non-empty, filesystem-safe name that
 *  carries the values it extracted.
 *
 *  The value assertion is the regression guard for the whole feature. Without it a name can be
 *  well-formed and still empty of content — every template slot rendering empty, a bare date — so
 *  Stage 4's claim is the rendered VALUES, not the shape. */
export async function name(s: Session): Promise<Session> {
  await ensure(s)
  const waived: string[] = []
  for (const r of s.plan) {
    if (!r.new) throw new Error(`Stage 4 produced no name for ${r.old}`)
    if (/[/\\:*?"<>|]/.test(r.new)) throw new Error(`Stage 4 name not sanitised: ${r.new}`)
    for (const hole of fieldsDropped(r)) waived.push(`${r.old} ${hole}`)
  }
  // A waived field is a hole, not a pass: it is named and it is red, never counted
  // as green. The old code returned true here and said nothing at all.
  if (waived.length) {
    throw new Error(
      `Stage 4 could not check ${waived.length} extracted value(s) for content — nothing alphanumeric to look for: ${waived.join('; ')}`
    )
  }
  return s
}

/**
 * outcome: plan written with pending rows, the old->new table PRINTED with
 * flagged rows first, and the originals unchanged.
 *
 * The table is half of I1's Outcome sentence, and an Outcome claim not asserted here is a claim no
 * node can be held to.
 */
export async function outcome(s: Session, name: string): Promise<Session> {
  await ensure(s)
  if (!(await Bun.file(s.planPath).exists())) {
    throw new Error('outcome: .docnamer-plan.json not written')
  }

  const lines = s.last.stdout.split('\n')
  const at = (r: PlanRow): number => lines.findIndex(l => l.includes(base(r.old)))
  for (const r of s.plan) {
    const i = at(r)
    if (i < 0) {
      throw new Error(
        `outcome: the table prints no line naming ${r.old}; stdout was:\n${s.last.stdout}`
      )
    }
    if (!lines[i].includes(base(r.new))) {
      throw new Error(
        `outcome: ${r.old}'s table line does not carry its new name ${r.new}: ${JSON.stringify(lines[i])}`
      )
    }
  }
  // Flagged rows first. The MARGIN the CLI printed is what a person reads, so
  // that is what is checked — a loop over r.flags passes on a table that marks
  // nothing at all, which is the vacuous shape this assertion exists to avoid.
  const flaggedCount = s.plan.filter(r => r.flags.length > 0).length
  for (const r of s.plan) {
    const marked = lines[at(r)].startsWith('!')
    const hasFlags = r.flags.length > 0
    if (marked !== hasFlags) {
      throw new Error(
        `outcome: ${r.old} is printed ${marked ? 'with' : 'without'} a "!" margin ` +
          `but ${hasFlags ? 'has' : 'has no'} flags`
      )
    }
  }
  if (flaggedCount > 0) {
    const firstRow = s.plan.reduce((a, b) => (at(a) <= at(b) ? a : b))
    if (firstRow.flags.length === 0) {
      throw new Error(
        `outcome: ${flaggedCount} row(s) are flagged yet the table opens with the clean row ${firstRow.old}`
      )
    }
  }
  for (const f of s.plan.filter(r => r.flags.length > 0)) {
    for (const c of s.plan.filter(r => r.flags.length === 0)) {
      if (at(f) > at(c)) {
        throw new Error(`outcome: flagged row ${f.old} is printed after clean row ${c.old}`)
      }
    }
  }

  // The frame is the only evidence the visual review gets, and each flow names
  // its own: one shared name means the last spec to run overwrites the others'
  // frames, so the judge reviews a different flow than the one it is judging.
  await frame(s.last.stdout, name)
  for (const r of s.plan) {
    if (r.status !== 'pending') {
      throw new Error(`outcome: row ${r.old} status ${r.status} != pending`)
    }
  }
  for (const [n, before] of s.originals) {
    const f = Bun.file(`${s.dir}/${n}`)
    if (f.size !== before.size || f.lastModified !== before.mtime) {
      throw new Error(`outcome: original ${n} was modified`)
    }
  }
  return s
}

// --- I2: Vision fallback only when OCR is weak --------------------------------

/** text: a text-layer document is planned from its text layer. */
export async function text(s: Session): Promise<Session> {
  await ensure(s)
  const textFiles = [...s.originals.keys()].filter(n => /\.(txt|md)$/i.test(n))
  if (!textFiles.length) throw new Skipped('I2 text: no text-layer fixture seeded')
  const planned = new Set(s.plan.map(r => base(r.old)))
  const missing = textFiles.filter(n => !planned.has(n))
  if (missing.length) {
    throw new Error(`I2 text: text-layer files not planned: ${missing.join(', ')}`)
  }
  return s
}

/** ocr: a scanned document is read by OCR. */
export async function ocr(s: Session): Promise<Session> {
  await ensure(s)
  const scanned = [...s.originals.keys()].filter(n => /scan/i.test(n))
  if (!scanned.length)
    throw new Skipped('I2 ocr: no scanned fixture seeded (tests/fixtures/ absent)')
  const planned = new Set(s.plan.map(r => base(r.old)))
  const missing = scanned.filter(n => !planned.has(n))
  if (missing.length) throw new Error(`I2 ocr: scanned files not planned: ${missing.join(', ')}`)
  return s
}

/** vision: page images were sent to the vision model only on weak OCR. */
export async function vision(s: Session): Promise<Session> {
  await ensure(s)
  const row = (name: string): PlanRow => {
    const found = s.plan.find(r => base(r.old) === name)
    if (!found) throw new Error(`I2 vision: ${name} was not planned`)
    return found
  }

  const noText = row(NO_TEXT_FIXTURE)
  if (noText.method !== 'vision') {
    throw new Error(
      `I2 vision: OCR read no glyphs from ${NO_TEXT_FIXTURE} yet method was ` +
        `${JSON.stringify(noText.method)}; the ladder did not fall through to the vision model`
    )
  }

  const withText = row('statement-text.pdf')
  if (withText.method !== 'text') {
    throw new Error(
      `I2 vision: statement-text.pdf has a usable text layer yet method was ` +
        `${JSON.stringify(withText.method)}; page images reached a model needlessly`
    )
  }
  return s
}

// --- I3: Collision-safe unique naming -----------------------------------------

/** render: template rendered, empty parts dropped, name sanitised. */
export async function render(s: Session): Promise<Session> {
  await ensure(s)
  for (const r of s.plan) {
    if (/\s{2,}/.test(r.new) || /^[\s_-]|[\s_-]$/.test(r.new)) {
      throw new Error(`I3 render: name has an empty template part: ${JSON.stringify(r.new)}`)
    }
    if (/[/\\:*?"<>|]/.test(r.new)) throw new Error(`I3 render: name not sanitised: ${r.new}`)
  }
  return s
}

/** collide: no two rows propose the same name. */
export async function collide(s: Session): Promise<Session> {
  await ensure(s)
  const seen = new Map<string, string>()
  for (const r of s.plan) {
    const key = r.new.toLowerCase()
    const prev = seen.get(key)
    if (prev) throw new Error(`I3 collide: ${r.old} and ${prev} both propose ${r.new}`)
    seen.set(key, r.old)
  }
  return s
}

/** suffix: a ` (n)` suffix always follows a base name that is taken. */
export async function suffix(s: Session): Promise<Session> {
  await ensure(s)
  const proposed = new Set(s.plan.map(r => r.new.toLowerCase()))
  for (const r of s.plan) {
    const m = r.new.match(/^(.*) \((\d+)\)(\.[^.]*)?$/)
    if (!m) continue
    const stem = (m[1] + (m[3] ?? '')).toLowerCase()
    if (!proposed.has(stem) && !s.originals.has(stem)) {
      throw new Error(`I3 suffix: ${r.new} has a suffix but no colliding base`)
    }
  }
  return s
}
