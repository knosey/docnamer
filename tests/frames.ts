/**
 * Every frame the CLI surface has, rendered from a real run of the installed
 * binary (visual-evidence-doctrine, Tier 1). Free except the plan surface:
 * `plan` is the one command whose output only exists once a model has read the
 * documents, so the table and the review screen share a single real run.
 *
 *   bun run build && bun tests/frames.ts
 *
 * Frames land in .audit/screenshots/ — gitignored, and the only directory the
 * judge reads. The documents are copied to a scratch folder first, so no frame
 * run ever leaves a plan file inside the repository.
 */
import { appBin } from './app-binary.ts'
import { frame } from './frame.ts'

const repo = import.meta.dir.replace(/\/tests$/, '')

/** The operator's own home: the frames must show a real plan, so the paid run
 * reads the machine's credential store rather than a throwaway one. */
const HOME = Bun.env.HOME
if (HOME === undefined) throw new Error('frames: HOME is unset')

/** Where the paid run reads its documents: a copy, so the repo stays clean. */
const WORK = '/tmp/docnamer-frames-docs'
const FIXTURES = ['acme-statement-scan.pdf', 'statement-text.pdf', 'letter.docx', 'receipt.png']

type Run = { code: number; stdout: string; stderr: string }

/** Bun types a spawn's stdin as optional whatever it was asked for; the guard
 * lives here so `run` itself stays a straight line. */
async function feed(p: Bun.Subprocess<'ignore' | 'pipe'>, input: string): Promise<void> {
  const sink = p.stdin
  if (sink === undefined) throw new Error('frames: spawn gave no stdin sink')
  await sink.write(input)
  await sink.end()
}

async function run(args: string[], home: string, input?: string): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  // A frame must show what the binary decides, never what the shell handed it.
  delete env.FIREWORKS_API_KEY
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  env.NO_COLOR = '1'
  const p = Bun.spawn([appBin, ...args], {
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env
  })
  if (input !== undefined) await feed(p, input)
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited
  ])
  return { code, stdout, stderr }
}

/** A throwaway home, optionally holding one credential store. */
async function home(pi?: unknown, own?: unknown): Promise<string> {
  const dir = `/tmp/docnamer-frame-home-${crypto.randomUUID()}`
  if (pi !== undefined) await Bun.write(`${dir}/.pi/agent/auth.json`, JSON.stringify(pi))
  if (own !== undefined) {
    await Bun.write(`${dir}/.config/docnamer/credentials.json`, JSON.stringify(own))
  }
  return dir
}

/** The scratch folder the paid run reads: the real fixtures, copied fresh. */
async function scratch(): Promise<string> {
  const cleared = Bun.spawnSync(['rm', '-rf', WORK])
  if (cleared.exitCode !== 0) {
    throw new Error(`frames: rm -rf ${WORK} failed: ${cleared.stderr.toString().trim()}`)
  }
  const made = Bun.spawnSync(['mkdir', '-p', WORK])
  if (made.exitCode !== 0) {
    throw new Error(`frames: mkdir -p ${WORK} failed: ${made.stderr.toString().trim()}`)
  }
  for (const name of FIXTURES) {
    await Bun.write(`${WORK}/${name}`, Bun.file(`${repo}/tests/fixtures/${name}`))
  }
  return WORK
}

const KEY = { type: 'api_key', key: 'k' }
const plain = await home()
const signedIn = await home({ fireworks: KEY })
const owns = await home(undefined, { fireworks: KEY })

/** The eval fixture set, copied fresh: its expected.json is the truth file. */
async function testset(): Promise<string> {
  const dir = '/tmp/docnamer-frames-testset'
  const cleared = Bun.spawnSync(['rm', '-rf', dir])
  if (cleared.exitCode !== 0) {
    throw new Error(`frames: rm -rf ${dir} failed: ${cleared.stderr.toString().trim()}`)
  }
  const made = Bun.spawnSync(['cp', '-R', `${repo}/tests/testset`, dir])
  if (made.exitCode !== 0) {
    throw new Error(`frames: cp -R tests/testset failed: ${made.stderr.toString().trim()}`)
  }
  return dir
}

const folder = await scratch()
// The machine's own credential store answers this run: the frames must show a
// real plan, and a fake key would only frame the failure path.
const planRun = await run(['plan', folder], HOME)
if (planRun.code !== 0) {
  throw new Error(`frames: plan exited ${planRun.code}: ${planRun.stderr.trim()}`)
}
if (!(await Bun.file(`${folder}/.docnamer-plan.json`).exists())) {
  throw new Error(`frames: plan wrote no plan file in ${folder}`)
}

const cases: [string, 'stdout' | 'stderr', () => Promise<Run>][] = [
  ['ui-01-help', 'stdout', () => run(['--help'], plain)],
  ['ui-02-plan-help', 'stdout', () => run(['plan', '--help'], plain)],
  ['ui-03-unknown', 'stderr', () => run(['bogus'], plain)],
  ['ui-04-bare', 'stderr', () => run([], plain)],
  ['ui-05-auth', 'stdout', () => run(['auth'], signedIn)],
  ['ui-06-login-picker', 'stdout', () => run(['login'], plain, 'q\n')],
  ['ui-07-plan-table', 'stdout', () => Promise.resolve(planRun)],
  // Accept three of the four rows, then apply and undo them: the two frames
  // showing the live progress are the run's own doing, not a hand-made plan.
  ['ui-08-review', 'stdout', () => run(['review', folder], HOME, '\r\r\rq')],
  ['ui-09-apply-progress', 'stdout', () => run(['apply', folder], HOME)],
  ['ui-10-undo-progress', 'stdout', () => run(['undo', folder], HOME)],
  // eval scores a whole fixture set against its expected.json: eight documents,
  // so this is the longest spinner of the lot and the one worth framing.
  ['ui-11-eval-progress', 'stdout', async () => run(['eval', await testset()], HOME)],
  ['ui-12-logout-picker', 'stdout', () => run(['logout'], owns, 'q\n')]
]

for (const [name, stream, next] of cases) {
  const r = await next()
  const text = stream === 'stdout' ? r.stdout : r.stderr
  const out = await frame(text, name)
  console.log(`${name}: exit ${r.code}, ${text.split('\n').length} line(s) -> ${out}`)
}
