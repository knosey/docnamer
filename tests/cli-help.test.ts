// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference =
  process.env.GRAPH_REFERENCE ?? String.raw`plutil -extract version raw package.json`

import { expect, test } from 'bun:test'
import { runChild } from './child.ts'
import { repo, resolveCli } from './doc-renamer-apply-harness.ts'

/**
 * T6 — the CLI's own front door: `--help`, `--version` and the exit codes.
 *
 * `src/cli.ts` is the work under test. A person meets this program by typing
 * `docnamer --help`, and until now that printed one line of usage to stderr and
 * exited 1 — because `--help` is not one of the five commands, so it fell into
 * the unknown-command branch at the top of `main()`. Nothing in the suite saw
 * it, which is the failure this file exists to make impossible.
 *
 * Every check spawns the CLI as a real subprocess through the resolver the apply
 * harness already owns (`DOCNAMER_BIN`, then the installed binary, then
 * `bun src/cli.ts`), so the artifact under test is the one a person runs.
 *
 * The reference `plutil -extract version raw package.json` is the version truth
 * `--version` must reproduce. It is read from the manifest and not from the CLI,
 * so a version string hard-coded in the source cannot satisfy it.
 *
 * The help text this suite pins has a CONTRACT, and `commands()` below depends
 * on it: a section heading sits alone on its line, and every line of the section
 * beneath it begins with two spaces, a name, then at least two spaces before its
 * description. A help text that stops honouring that contract fails here.
 */

const COMMANDS = ['plan', 'review', 'apply', 'undo', 'eval', 'login', 'logout', 'auth'] as const

/** Run the CLI as a real subprocess and collect its three observable outputs. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = await resolveCli()
  if (argv === null) {
    throw new Error('no docnamer reachable: set DOCNAMER_BIN, or build one with `bun run build`')
  }
  return runChild([...argv, ...args], { cwd: repo })
}

/** What the reference command prints — the manifest's version. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(reference.split(/\s+/).filter(Boolean), {
    cwd: repo,
    timeout: 30000,
    killSignal: 'SIGTERM'
  })
  return proc.stdout.toString().trim()
}

/**
 * The names a section of a help text advertises, in order. Deterministic string
 * work, no regex: a heading line, then the contiguous indented block under it.
 */
function names(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trimEnd() === heading)
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break
    const token = line.trim().split(' ')[0] ?? ''
    if (token.length > 0) out.push(token)
  }
  return out
}

test('cli: --help and -h exit 0 and print help to stdout, not stderr', async () => {
  for (const flag of ['--help', '-h']) {
    const r = await cli(flag)
    expect(r.code, `${flag} must exit 0, not ${r.code}`).toBe(0)
    expect(r.stdout.trim().length, `${flag} printed nothing to stdout`).toBeGreaterThan(0)
    expect(r.stderr, `${flag} wrote to stderr; help belongs on stdout`).toBe('')
  }
})

test('cli: --help names the program, a USAGE line, and every command it dispatches', async () => {
  const r = await cli('--help')
  expect(r.stdout, 'help must say what the program is called').toContain('docnamer')
  expect(r.stdout, 'help must carry a USAGE section').toContain('USAGE')
  for (const cmd of COMMANDS) {
    expect(r.stdout, `help does not mention the ${cmd} command`).toContain(cmd)
  }
})

test('cli: help advertises no command that is not really there', async () => {
  // The anti-rot check. A COMMANDS section that drifts from the dispatch is the
  // way help goes stale, so each advertised name is driven for real. `--help`
  // reaches every command before its work starts, so this costs no model call.
  const advertised = names((await cli('--help')).stdout, 'COMMANDS')
  expect(advertised.length, 'the COMMANDS section listed nothing').toBeGreaterThan(0)
  expect(advertised, 'the COMMANDS section is not the roster the CLI dispatches').toEqual([
    ...COMMANDS
  ])
  for (const cmd of advertised) {
    const r = await cli(cmd, '--help')
    expect(r.code, `help advertises \`${cmd}\`, but \`${cmd} --help\` exited ${r.code}`).toBe(0)
    expect(r.stdout.trim().length, `\`${cmd} --help\` printed nothing`).toBeGreaterThan(0)
  }
})

test('cli: an unknown command fails, names the token, and points at --help', async () => {
  const r = await cli('frobnicate')
  // 2, not 1: a script must be able to tell a refused invocation from a run
  // that started and failed, and only the code can carry that. 1 stays for
  // everything that got as far as doing something.
  expect(r.code, 'an unknown command must exit 2, the code for a refused invocation').toBe(2)
  expect(r.stdout, 'an error belongs on stderr, not stdout').toBe('')
  expect(r.stderr, 'the message must name what was not understood').toContain('frobnicate')
  expect(r.stderr, 'the message must say how to find the real commands').toContain('--help')
})

test('cli: a bare invocation is a usage error, and says so on stderr', async () => {
  const r = await cli()
  // 2, the same refusal code as an unknown command: nothing ran, so nothing
  // failed. 1 is reserved for an invocation that was accepted and then broke.
  expect(r.code, 'a bare invocation must exit 2, the code for a refused invocation').toBe(2)
  expect(r.stdout, 'usage on no arguments belongs on stderr').toBe('')
  expect(r.stderr, 'a bare invocation must print usage').toContain('usage')
})

test('cli: a command named without its folder is refused the same way', async () => {
  const r = await cli('plan')
  expect(r.code, 'a missing folder must exit 2, not 1').toBe(2)
  expect(r.stdout, 'usage on a missing argument belongs on stderr').toBe('')
  expect(r.stderr, 'the refusal must print usage').toContain('usage')
})

test('cli: --version prints the manifest version and exits 0', async () => {
  const want = referenceOutput()
  expect(
    want.length,
    'the reference command printed no version to compare against'
  ).toBeGreaterThan(0)
  for (const flag of ['--version', '-v']) {
    const r = await cli(flag)
    expect(r.code, `${flag} must exit 0, not ${r.code}`).toBe(0)
    expect(r.stdout.trim(), `${flag} must print the manifest version`).toBe(`docnamer ${want}`)
  }
})

test('cli: help documents the options the parser accepts', async () => {
  // The two options `main()` parses. A flag nobody can discover is a flag
  // nobody uses, and `--run` guards a destructive undo, so it matters most.
  const help = (await cli('--help')).stdout
  for (const flag of ['--recursive', '--run']) {
    expect(help, `help does not document ${flag}`).toContain(flag)
  }
})
