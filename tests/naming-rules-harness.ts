/**
 * Shared e2e harness for the naming-rules feature
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * Every digraph names the same three steps. A flow test is those steps in order
 * plus the assertion of its Outcome, and it reads nothing else of the app:
 *
 *   const s = new Session('I1')
 *   await entry(s); await step(s); await outcome(s)
 *   // assert s.names against the Outcome sentence
 *
 * `entry` boots an isolated folder and seeds the file the interaction plans.
 * `step` runs `docnamer plan` on that folder. `outcome` reads the proposed
 * names off the plan and the printed table.
 *
 * Every run stands alone: a fresh temp dir, a CLI resolved per run, nothing
 * written into the repo except a frame under `.audit/screenshots/`.
 */
import { mkdir } from 'node:fs/promises'
import { CONFIG_FILE } from '../src/config.ts'
import { appBin } from './app-binary.ts'
import { runChild } from './child.ts'
import { frame } from './frame.ts'
import { planRows } from './plan-file.ts'
import { ensureProviderKey, MODEL_CALL_MS } from './preload.ts'
import { scratch } from './scratch.ts'

export type PlanRow = {
  old: string
  new: string
  type: string
  fields: Record<string, string>
  flags: string[]
  summary: string
  status: string
}

/** Which interaction this run plans. `smoke` is the harness's own boot file. */
export type FlowId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'smoke'

export class Session {
  flow: FlowId
  /** Per-run working folder, outside the repo. */
  dir = ''
  planPath = ''
  plan: PlanRow[] = []
  /** Proposed filenames, in plan order. Flow tests assert their Outcome on these. */
  names: string[] = []
  cli: string[] | null = null
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  booted = false

  constructor(flow: FlowId = 'smoke') {
    this.flow = flow
  }
}

export const repo = import.meta.dir.replace(/\/tests$/, '')

/**
 * Each flow is seeded with bytes that ARE the document its interaction describes:
 * the reader takes the type and fields from the page, so a statement's bytes
 * under a passport's filename can only ever produce a statement.
 */
const CONTRACT = 'tests/fixtures/contract-saulx-crowdbuilding.pdf'
const INVOICE = 'tests/fixtures/invoice-crowdbuilding.pdf'
const PASSPORT = 'tests/fixtures/passport-reisepass.pdf'
const AUTHORITY = 'tests/fixtures/eeavisa-authority.pdf'
const PHOTO = 'tests/fixtures/receipt.png'
const SCREENSHOT = 'tests/fixtures/invoice-page-screenshot.png'

type Seed = { name: string; body?: string; copy?: string }

/** One note under two names, so both render the same name and one must take a (2). */
const NOTE = 'A note with a Finder collision suffix and no version field.\n'

/** The file each interaction tells `docnamer plan` to name, under that exact filename. */
const SEED: Record<FlowId, Seed[]> = {
  I1: [
    { name: '20260217 - Contract - Based Platform - Crowdbuilding (draft).pdf', copy: CONTRACT }
  ],
  I2: [
    { name: '20260006 Crowdbuilding February v3.pdf', copy: INVOICE },
    { name: '20260006 Crowdbuilding V4.pdf', copy: INVOICE }
  ],
  I3: [{ name: 'passport-jacqui-with-stamps.pdf', copy: PASSPORT }],
  I4: [{ name: 'Authority-Jac-EEAVISA.pdf', copy: AUTHORITY }],
  I5: [{ name: 'photo-not-a-document.png', copy: PHOTO }],
  I6: [{ name: 'screenshot-of-invoice.png', copy: SCREENSHOT }],
  I7: [
    { name: 'notes (2).txt', body: NOTE },
    { name: 'notes.txt', body: NOTE }
  ],
  smoke: [
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
    }
  ]
}

async function shell(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runChild(cmd, { env: { ...Bun.env }, timeoutMs: MODEL_CALL_MS })
}

async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN
  if (override && override.trim()) return override.trim().split(/\s+/)
  const src = `${repo}/src/cli.ts`
  if (await Bun.file(src).exists()) return [Bun.which('bun') ?? 'bun', src]
  if (await Bun.file(appBin).exists()) return [appBin]
  return null
}

/** Boot the isolated environment and seed this flow's files. `entry` calls this; the smoke proves isolation through `s.booted`. */
async function boot(s: Session): Promise<void> {
  if (s.booted) return
  const dir = scratch('naming-rules')
  await mkdir(dir, { recursive: true })
  s.dir = dir
  s.planPath = `${dir}/.docnamer-plan.json`
  const files = SEED[s.flow]
  if (!files) throw new Error(`boot: no seed for flow ${s.flow}`)
  for (const f of files) {
    if (f.copy) {
      const bytes = await Bun.file(`${repo}/${f.copy}`).arrayBuffer()
      await Bun.write(`${dir}/${f.name}`, bytes)
    } else if (f.body !== undefined) {
      await Bun.write(`${dir}/${f.name}`, f.body)
    } else {
      throw new Error(`boot: seed ${f.name} has neither body nor copy`)
    }
  }
  const config = `${repo}/${CONFIG_FILE}`
  if (await Bun.file(config).exists()) await Bun.write(`${dir}/${CONFIG_FILE}`, Bun.file(config))
  s.cli = await resolveCli()
  s.booted = true
}

const missingCli = (): Error =>
  new Error(
    'docnamer CLI absent: the program under test is not built yet, so this flow is red for the right reason. Set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts'
  )

async function runPlan(s: Session): Promise<void> {
  if (!s.cli) throw missingCli()
  await ensureProviderKey()
  const res = await shell([...s.cli, 'plan', s.dir])
  s.last = res
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  const parsed = JSON.parse(await Bun.file(s.planPath).text()) as unknown
  s.plan = planRows<PlanRow>(parsed)
  s.names = s.plan.map(r => r.new)
}

/** entry: boot the isolated folder and seed the file this interaction plans. */
export async function entry(s: Session): Promise<Session> {
  await boot(s)
  return s
}

/** step: give the seeded file to `docnamer plan` — the action every interaction names. */
export async function step(s: Session): Promise<Session> {
  if (!s.booted) await boot(s)
  if (s.last.code !== 0) await runPlan(s)
  return s
}

/**
 * outcome: the proposed names, read off the plan and confirmed on the printed table.
 * Flow tests assert their Outcome sentence against `s.names`; this step only observes.
 */
export async function outcome(s: Session): Promise<Session> {
  if (s.last.code !== 0) await step(s)
  if (!(await Bun.file(s.planPath).exists())) {
    throw new Error('outcome: .docnamer-plan.json not written')
  }
  if (s.names.length === 0) throw new Error('outcome: plan proposed no names')
  for (const name of s.names) {
    const base = name.split('/').pop() ?? name
    if (!s.last.stdout.includes(base)) {
      throw new Error(`outcome: printed table does not contain proposed name ${base}`)
    }
  }
  await frame(s.last.stdout, `naming-rules-${s.flow}`)
  return s
}
