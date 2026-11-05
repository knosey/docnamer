/**
 * The plumbing every feature harness shares: the repo root, a named hole, the
 * child runner, the artifact under test, and the isolated folder a run lives in.
 *
 * Each harness under tests/ owns the steps of its own feature's digraphs; what
 * is here is only the part that was the same in all of them. Anything a single
 * feature needs stays in that feature's harness.
 */
import { CONFIG_FILE } from "../src/config.ts"
import { PLAN_FILE, type PlanRow } from "../src/commands.ts"
import { appBin } from "./app-binary.ts"
import { runChild } from "./child.ts"
import { planRows, base } from "./plan-file.ts"
import { ensureProviderKey, MODEL_CALL_MS } from "./preload.ts"
import { scratch } from "./scratch.ts"

export type { PlanRow }

/** Repo root. Exported so a spec can read the tree or the config a run seeded. */
export const repo = import.meta.dir.replace(/\/tests$/, "")

/** A named hole: the claim cannot be closed on the current observation surface. */
export class Skipped extends Error {
  // Read structurally by tests/preload.ts, which cannot import this module
  // (this module imports it): that reader turns a skip into a report line.
  // fallow-ignore-next-line unused-class-member
  readonly skip = true
  constructor(readonly claim: string) {
    super("SKIP: " + claim)
    this.name = "Skipped"
  }
}

/**
 * The program under test being absent is the RIGHT reason for a flow test to be
 * red, so this is a failure and not a `Skipped`: only a claim the observation
 * surface cannot see is a `Skipped`, an unbuilt CLI is a failure.
 */
export const missingCli = (): Error =>
  new Error(
    "docnamer CLI absent: the program under test is not built yet, so this flow is red for the right reason. Set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts"
  )

/** Run a child with this process's environment and the model budget as its deadline. */
export async function shell(
  cmd: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The child must carry the provider key: pi-ai resolves Fireworks auth from its
  // own environment, and ensureProviderKey() sets it on THIS process. Handing the
  // environment over explicitly is what makes that reach the child; relying on
  // inheritance left every analyse call with no key.
  //
  // Any call here can reach a model, so the deadline is the model budget: a child
  // that stops answering is SIGTERMed with its command named in the throw, rather
  // than hanging the file with no cause on the report.
  return runChild(cmd, { env: { ...Bun.env }, timeoutMs: MODEL_CALL_MS })
}

/** The one place that decides which artifact is under test. The TREE comes first:
 *  the installed bundle is whatever was built last, so preferring it tested stale
 *  code and reported the result as this tree's flow. The bundle is the fallback for
 *  a checkout with no sources, and DOCNAMER_BIN overrides both.
 *
 *  Exported because a flow that never reaches a model (tests/cli-help.test.ts, the
 *  front door) must still drive the same artifact a harness drives, not a second
 *  guess at it. */
export async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN
  if (override && override.trim()) return override.trim().split(/\s+/)
  const src = `${repo}/src/cli.ts`
  if (await Bun.file(src).exists()) return [Bun.which("bun") ?? "bun", src]
  if (await Bun.file(appBin).exists()) return [appBin]
  return null
}

/** The top-level entries of a folder, for the steps that count what a command left behind. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob("*").scan({ cwd: dir, onlyFiles: true })) out.push(rel)
  return out
}

/** What every harness's Session carries, so one boot can serve them all. */
export type RunFolder = {
  dir: string
  planPath: string
  cli: string[] | null
  last: { code: number; stdout: string; stderr: string }
  booted: boolean
}

/**
 * The isolation every run shares: a scratch folder outside the repo, the repo's
 * own config beside the seed (docnamer.json is read from the FOLDER being
 * planned, so without it a run falls back to the built-in DEFAULT_CONFIG — a
 * different roster and a vision model this machine cannot call), the provider
 * key on this process, and the CLI resolved per run.
 *
 * Exported for the smoke tests, which prove the folder stays out of the repo.
 */
export async function bootRun(s: RunFolder, prefix: string): Promise<string> {
  const dir = scratch(prefix)
  s.dir = dir
  s.planPath = `${dir}/${PLAN_FILE}`
  const config = `${repo}/${CONFIG_FILE}`
  if (await Bun.file(config).exists()) await Bun.write(`${dir}/${CONFIG_FILE}`, Bun.file(config))
  await ensureProviderKey()
  s.cli = await resolveCli()
  s.booted = true
  return dir
}

/** The seed files plus every fixture, in the folder a run plans.
 *
 *  A missing tests/fixtures is a broken run, not a degraded one: swallowing the
 *  ENOENT left the flow testing the hand-seeded files alone and calling it a pipeline. */
export async function seedRun(
  dir: string,
  files: readonly { name: string; body: string }[]
): Promise<void> {
  for (const f of files) await Bun.write(`${dir}/${f.name}`, f.body)
  const fixtures = `${repo}/tests/fixtures`
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: fixtures, onlyFiles: true })) {
    const bytes = await Bun.file(`${fixtures}/${rel}`).arrayBuffer()
    await Bun.write(`${dir}/${base(rel)}`, bytes)
  }
}

/** What `plan` must leave untouched, recorded before it runs. */
export async function snapshotSizes(
  dir: string,
  into: Map<string, { size: number; mtime: number }>
): Promise<void> {
  for (const name of await listFiles(dir)) {
    const f = Bun.file(`${dir}/${name}`)
    into.set(name, { size: f.size, mtime: f.lastModified })
  }
}

/** The child's environment: the operator's, minus any key the shell handed it —
 *  a run must show what the program decides, never what the shell decided. */
export function homeEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  delete env.FIREWORKS_API_KEY
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  return env
}

/** The folder's newest `.docnamer-undo-<timestamp>.json`, by name, or null. */
export async function latestUndo(dir: string): Promise<string | null> {
  const found: string[] = []
  for await (const rel of new Bun.Glob(".docnamer-undo-*.json").scan({
    cwd: dir,
    onlyFiles: true
  })) {
    found.push(rel)
  }
  found.sort()
  return found.length ? (found[found.length - 1] ?? null) : null
}

/** Run `docnamer plan <folder>` and parse the plan file it writes. */
export async function runPlan(s: RunFolder & { plan: PlanRow[] }): Promise<void> {
  if (!s.cli) throw missingCli()
  const res = await shell([...s.cli, "plan", s.dir])
  s.last = res
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`)
  }
  s.plan = planRows<PlanRow>(JSON.parse(await Bun.file(s.planPath).text()) as unknown)
}
