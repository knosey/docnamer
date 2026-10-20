/**
 * Every frame the CLI surface has, rendered from a real run of the installed
 * binary (visual-evidence-doctrine, Tier 1). Free except the plan surface:
 * `plan` is the one command whose output only exists once a model has read the
 * documents, so the table and the review screen share a single real run.
 *
 *   bun run build && bun run frames
 *
 * Frames land in .audit/screenshots/ — gitignored, and the only directory the
 * judge reads. The documents are copied to a scratch folder first, so no frame
 * run ever leaves a plan file inside the repository, and the whole scratch tree
 * is removed when the run ends.
 *
 * Every case below is CHECKED before it is framed: the exit code, that the
 * framed stream is not empty, and that it carries no escape sequence. A help
 * screen that printed the wrong thing used to render a green frame.
 */
import { mkdirSync, cpSync } from 'node:fs'
import { visibleWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { appBin } from './app-binary.ts'
import { frame } from './frame.ts'
import { runChild, type ChildRun } from './child.ts'
import { scratch, cleanupScratch } from './scratch.ts'
import { drive, hasPty, makeTerminal, paints } from './pty.ts'

const repo = import.meta.dir.replace(/\/tests$/, '')

/** `src/cli.ts` USAGE_EXIT: a refused invocation is not a failed run. */
const USAGE_EXIT = 2

/** The operator's own home answers the paid runs, so a frame shows what a real
 *  credential store gets rather than a failure path. */
const HOME = Bun.env.HOME
if (HOME === undefined) throw new Error('frames: HOME is unset')

/** Four OCR reads plus four model calls: the deadline is a ceiling, not a guess. */
const PAID_MS = 600_000

/** One scratch root for the whole run: documents, homes and test set inside it. */
const ROOT = scratch('docnamer-frames')

/** The operator's own home answers the paid runs: `run` is handed one of the
 *  throwaway homes below, never a fake key. */
async function run(args: string[], home: string, input?: string): Promise<ChildRun> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  // A frame must show what the binary decides, never what the shell handed it.
  delete env.FIREWORKS_API_KEY
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  env.NO_COLOR = '1'
  return runChild([appBin, ...args], { cwd: repo, env, input, timeoutMs: PAID_MS })
}

/** A throwaway home, optionally holding one credential store. */
async function home(pi?: unknown, own?: unknown): Promise<string> {
  const dir = scratch('docnamer-frames-home')
  if (pi !== undefined) await Bun.write(`${dir}/.pi/agent/auth.json`, JSON.stringify(pi))
  if (own !== undefined) {
    await Bun.write(`${dir}/.config/docnamer/credentials.json`, JSON.stringify(own))
  }
  return dir
}

/** The scratch folder the paid run reads: the real fixtures, copied fresh. */
async function docs(): Promise<string> {
  const dir = `${ROOT}/docs`
  mkdirSync(dir, { recursive: true })
  const FIXTURES = ['acme-statement-scan.pdf', 'statement-text.pdf', 'letter.docx', 'receipt.png']
  for (const name of FIXTURES) {
    await Bun.write(`${dir}/${name}`, Bun.file(`${repo}/tests/fixtures/${name}`))
  }
  return dir
}

/** The eval fixture set, copied fresh: its expected.json is the truth file. */
async function testset(): Promise<string> {
  const dir = `${ROOT}/testset`
  cpSync(`${repo}/tests/testset`, dir, { recursive: true })
  return dir
}

const KEY = { type: 'api_key', key: 'k' }
const plain = await home()
const signedIn = await home({ fireworks: KEY })
const owns = await home(undefined, { fireworks: KEY })

/** Run one frame by name: `FRAMES_ONLY=ui-13-login-picker-80 bun run frames`. */
const ONLY = Bun.env.FRAMES_ONLY

try {
  const folder = await docs()
  // The machine's own credential store answers this run: the frames must show a
  // real plan, and a fake key would only frame the failure path. Lazy, so a
  // FRAMES_ONLY run naming no plan-fed frame makes no model call.
  let planRun: ChildRun | undefined
  const planned = async (): Promise<ChildRun> => {
    if (planRun !== undefined) return planRun
    const r = await run(['plan', folder], HOME)
    if (r.code !== 0) throw new Error(`frames: plan exited ${r.code}: ${r.stderr.trim()}`)
    if (!(await Bun.file(`${folder}/.docnamer-plan.json`).exists())) {
      throw new Error(`frames: plan wrote no plan file in ${folder}`)
    }
    planRun = r
    return r
  }

  const cases: [string, number, 'stdout' | 'stderr', () => Promise<ChildRun>][] = [
    ['ui-01-help', 0, 'stdout', () => run(['--help'], plain)],
    ['ui-02-plan-help', 0, 'stdout', () => run(['plan', '--help'], plain)],
    ['ui-03-unknown', USAGE_EXIT, 'stderr', () => run(['bogus'], plain)],
    ['ui-04-bare', USAGE_EXIT, 'stderr', () => run([], plain)],
    ['ui-05-auth', 0, 'stdout', () => run(['auth'], signedIn)],
    ['ui-06-login-picker', 0, 'stdout', () => run(['login'], plain, 'q\n')],
    ['ui-07-plan-table', 0, 'stdout', () => planned()],
    // Accept three of the four rows, then apply and undo them: the two frames
    // showing the live progress are the run's own doing, not a hand-made plan.
    [
      'ui-08-review',
      0,
      'stdout',
      async () => {
        await planned()
        return run(['review', folder], HOME, '\r\r\rq')
      }
    ],
    [
      'ui-09-apply-progress',
      0,
      'stdout',
      async () => {
        await planned()
        return run(['apply', folder], HOME)
      }
    ],
    [
      'ui-10-undo-progress',
      0,
      'stdout',
      async () => {
        await planned()
        return run(['undo', folder], HOME)
      }
    ],
    // eval scores a whole fixture set against its expected.json: eight documents,
    // so this is the longest spinner of the lot and the one worth framing.
    ['ui-11-eval-progress', 0, 'stdout', async () => run(['eval', await testset()], HOME)],
    ['ui-12-logout-picker', 0, 'stdout', () => run(['logout'], owns, 'q\n')]
  ]

  for (const [name, code, stream, next] of cases) {
    if (ONLY !== undefined && name !== ONLY) continue
    const r = await next()
    // A frame is evidence only if the run behind it is checked.
    if (r.code !== code) {
      throw new Error(`frames: ${name} exited ${r.code}, expected ${code}: ${r.stderr.trim()}`)
    }
    const text = stream === 'stdout' ? r.stdout : r.stderr
    if (text.trim().length === 0) {
      throw new Error(`frames: ${name} printed nothing on ${stream}`)
    }
    // NO_COLOR=1 is in the child's environment, so the framed stream carries no
    // escape sequence at all — the contract cli-help.test.ts holds the CLI to.
    if (text.includes(String.fromCharCode(27))) {
      throw new Error(`frames: ${name} emitted an escape sequence with NO_COLOR set`)
    }
    const out = await frame(text, name)
    console.log(`${name}: exit ${r.code}, ${text.split('\n').length} line(s) -> ${out}`)
  }

  // ui-06 is the piped rendering; this is the frame a person on a terminal
  // sees, on the 80 columns where the status cell used to push the Fireworks
  // row to 117 cells, the terminal wrapped it, and every redraw landed a row
  // low. Free: the signed-in store is seeded and no model is called.
  if ((ONLY === undefined || ONLY === 'ui-13-login-picker-80') && hasPty) {
    const t = makeTerminal(80, 24)
    try {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
      delete env.FIREWORKS_API_KEY
      delete env.XDG_CONFIG_HOME
      // The piped frames above run under NO_COLOR; a terminal frame does not.
      delete env.NO_COLOR
      env.HOME = signedIn
      env.TERM = 'xterm-256color'
      const r = await drive(t, [appBin, 'login'], [['Sign in to a provider', '\u001b']], {
        cwd: repo,
        env
      })
      if (r.code !== 0) throw new Error(`frames: ui-13-login-picker-80 exited ${String(r.code)}`)
      const first = paints(r.output)[0]
      if (first === undefined) throw new Error('frames: ui-13-login-picker-80 drew no picker frame')
      for (const line of first.lines) {
        const w = visibleWidth(line)
        if (w > 80) {
          throw new Error(`frames: ui-13-login-picker-80 drew ${String(w)} cells on 80: ${line}`)
        }
      }
      const out = await frame(first.lines.join('\n'), 'ui-13-login-picker-80')
      console.log(`ui-13-login-picker-80: exit 0, ${String(first.lines.length)} line(s) -> ${out}`)
    } finally {
      t.terminal.close()
    }
  }
} finally {
  cleanupScratch()
}
