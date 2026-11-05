/**
 * Shared e2e harness for the naming-rules feature
 * (docs/adr/0004-naming-rules.md).
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
import { frame } from "./frame.ts"
import { bootRun, repo, runPlan, type PlanRow } from "./harness.ts"

export { repo }

/** Which interaction this run plans. `smoke` is the harness's own boot file. */
export type FlowId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "smoke"

export class Session {
  flow: FlowId
  /** Per-run working folder, outside the repo. */
  dir = ""
  planPath = ""
  plan: PlanRow[] = []
  /** Proposed filenames, in plan order. Flow tests assert their Outcome on these. */
  names: string[] = []
  // Written by bootRun and read through RunFolder inside it; a Session never
  // reads its own cli.
  // fallow-ignore-next-line unused-class-member
  cli: string[] | null = null
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: "", stderr: "" }
  booted = false

  constructor(flow: FlowId = "smoke") {
    this.flow = flow
  }
}

/**
 * Each flow is seeded with bytes that ARE the document its interaction describes:
 * the reader takes the type and fields from the page, so a statement's bytes
 * under a passport's filename can only ever produce a statement.
 */
const CONTRACT = "tests/fixtures/contract-saulx-crowdbuilding.pdf"
const INVOICE = "tests/fixtures/invoice-crowdbuilding.pdf"
const PASSPORT = "tests/fixtures/passport-reisepass.pdf"
const AUTHORITY = "tests/fixtures/eeavisa-authority.pdf"
const PHOTO = "tests/fixtures/receipt.png"
const SCREENSHOT = "tests/fixtures/invoice-page-screenshot.png"

type Seed = { name: string; body?: string; copy?: string }

/** One note under two names, so both render the same name and one must take a (2). */
const NOTE = "A note with a Finder collision suffix and no version field.\n"

/** The file each interaction tells `docnamer plan` to name, under that exact filename. */
const SEED: Record<FlowId, Seed[]> = {
  I1: [
    { name: "20260217 - Contract - Based Platform - Crowdbuilding (draft).pdf", copy: CONTRACT }
  ],
  I2: [
    { name: "20260006 Crowdbuilding February v3.pdf", copy: INVOICE },
    { name: "20260006 Crowdbuilding V4.pdf", copy: INVOICE }
  ],
  I3: [{ name: "passport-jacqui-with-stamps.pdf", copy: PASSPORT }],
  I4: [{ name: "Authority-Jac-EEAVISA.pdf", copy: AUTHORITY }],
  I5: [{ name: "photo-not-a-document.png", copy: PHOTO }],
  I6: [{ name: "screenshot-of-invoice.png", copy: SCREENSHOT }],
  I7: [
    { name: "notes (2).txt", body: NOTE },
    { name: "notes.txt", body: NOTE }
  ],
  smoke: [
    {
      name: "invoice-acme-2026-04.txt",
      body: [
        "INVOICE",
        "Acme Ltd",
        "Invoice number: INV-0042",
        "Date: 03/04/2026",
        "Total: 482.50 GBP",
        ""
      ].join("\n")
    }
  ]
}

/** Boot the isolated folder and seed this flow's files; the smoke proves isolation through `s.booted`. */
async function boot(s: Session): Promise<void> {
  if (s.booted) return
  const dir = await bootRun(s, "naming-rules")
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
}

/** entry: boot the isolated folder and seed the file this interaction plans. */
export async function entry(s: Session): Promise<Session> {
  await boot(s)
  return s
}

/** step: give the seeded file to `docnamer plan` — the action every interaction names. */
export async function step(s: Session): Promise<Session> {
  if (!s.booted) await boot(s)
  if (s.last.code !== 0) {
    await runPlan(s)
    s.names = s.plan.map(r => r.new)
  }
  return s
}

/**
 * outcome: the proposed names, read off the plan and confirmed on the printed table.
 * Flow tests assert their Outcome sentence against `s.names`; this step only observes.
 */
export async function outcome(s: Session): Promise<Session> {
  if (s.last.code !== 0) await step(s)
  if (!(await Bun.file(s.planPath).exists())) {
    throw new Error("outcome: .docnamer-plan.json not written")
  }
  if (s.names.length === 0) throw new Error("outcome: plan proposed no names")
  for (const name of s.names) {
    const base = name.split("/").pop() ?? name
    if (!s.last.stdout.includes(base)) {
      throw new Error(`outcome: printed table does not contain proposed name ${base}`)
    }
  }
  await frame(s.last.stdout, `naming-rules-${s.flow}`)
  return s
}
