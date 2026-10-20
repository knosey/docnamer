// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? 'echo 0'

import { expect, test } from 'bun:test'
import { runChild } from './child.ts'

/**
 * S2 — the CLI's chokepoints route through a terminal DEVICE, not through the
 * process's own fds.
 *
 * A LaunchServices-launched bun binary has no fd for the tty it was handed, so
 * the device path is the only way in and out: `Bun.file(path).writer()` for
 * every byte `src/ui.ts` writes and `Bun.file(path).stream()` for every byte
 * `src/prompt.ts` reads. This suite drives the CLI with the wrapper's flag set
 * and asserts on what the program DID — the exit code it left in the file, the
 * text that landed in the device rather than on stdout — never on a screen. The
 * real pty lives in the wrapper's own test; here a plain file is enough to
 * prove the routing.
 */

const ESC = String.fromCharCode(27)
const repo = new URL('..', import.meta.url).pathname

/** The code the reference run leaves: the truth the exit file is compared to. */
async function referenceOutput(): Promise<string> {
  const proc = Bun.spawnSync(['/bin/sh', '-c', reference], {
    timeout: 30000,
    killSignal: 'SIGTERM'
  })
  return proc.stdout.toString().trim()
}

/** A throwaway directory per test: a run must never inherit the last one's
 *  device or exit file (a gate that passes alone and fails in sequence). */
async function tempDir(): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/device-cli-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, '')
  return dir
}

/** The environment a person has: colour on, no NO_COLOR to turn it off. */
function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value
  delete out.NO_COLOR
  out.TERM = 'xterm-256color'
  return out
}

type Run = { code: number; out: string; err: string }

/** The CLI as the wrapper launches it: the source through bun, so the suite
 *  needs no compiled binary. */
async function runCli(args: string[], environment: Record<string, string>): Promise<Run> {
  const run = await runChild([process.execPath, 'src/cli.ts', ...args], {
    cwd: repo,
    env: environment
  })
  return { code: run.code, out: run.stdout, err: run.stderr }
}

/** The bytes a file holds, or null when the program never created it — a
 *  missing device is a failed check, never an uncaught throw. */
async function read(path: string): Promise<string | null> {
  return (await Bun.file(path).exists()) ? Bun.file(path).text() : null
}

test('a successful run through the device leaves the reference exit code', async () => {
  const expected = await referenceOutput()
  const dir = await tempDir()
  const device = `${dir}/tty`
  const exitFile = `${dir}/exit`

  const run = await runCli(
    ['--tty', device, '--cols', '100', '--rows', '40', '--exit-file', exitFile, '--version'],
    env()
  )

  const code = await read(exitFile)
  expect(code, 'the app must write its exit code to --exit-file').not.toBeNull()
  expect(code?.trim(), 'the exit file must carry the reference code').toBe(expected)

  const wrote = await read(device)
  expect(wrote, 'the app must write its output through the device, not stdout').not.toBeNull()
  expect(wrote, 'the version line must land in the device').toContain('docnamer ')
  expect(run.out, 'nothing may go to the process stdout when a device is given').toBe('')
})

test('the device flags are stripped, so the command after them still runs', async () => {
  const expected = await referenceOutput()
  const dir = await tempDir()
  const device = `${dir}/tty`
  const exitFile = `${dir}/exit`

  const run = await runCli(
    ['--tty', device, '--cols', '100', '--rows', '40', '--exit-file', exitFile, '--help'],
    env()
  )

  const wrote = await read(device)
  expect(wrote, 'the help must be written through the device').not.toBeNull()
  expect(wrote, 'a flag is not a command: the help still renders').toContain('COMMANDS')
  expect(await read(exitFile), 'a completed help exits with the reference code').toBe(expected)
  expect(run.err, 'a stripped flag must not read as an unknown command').toBe('')
})

test('--cols and --rows force the tty style, so the output is styled', async () => {
  const dir = await tempDir()
  const device = `${dir}/tty`
  const exitFile = `${dir}/exit`

  const run = await runCli(
    ['--tty', device, '--cols', '100', '--rows', '40', '--exit-file', exitFile, 'bogus'],
    env()
  )

  const wrote = await read(device)
  expect(wrote, 'the refusal must be written through the device').not.toBeNull()
  expect(
    wrote?.includes(ESC),
    'with --cols/--rows the program must style for a tty (colour on a device that is not stdout)'
  ).toBe(true)
  expect(await read(exitFile), 'a refused invocation reports its code through the device').toBe('2')
  expect(run.out, 'the refusal belongs to the device, not stdout').toBe('')
})

test('a run without a device keeps the direct, piped path', async () => {
  const run = await runCli(['--version'], env())

  expect(run.code, 'the direct path still exits 0').toBe(0)
  expect(run.out, 'the direct path still prints to stdout').toContain('docnamer ')
})
