import { expect, test } from 'bun:test'
import { appBin as BINARY, appPlist as PLIST, wrapper as WRAPPER } from './app-binary.ts'
import { PLAN_FILE } from '../src/commands.ts'

/**
 * S4 — the wrapper, driven end to end through a real `open` on a real pty.
 *
 * The wrapper is the only thing a person runs: `~/bin/docnamer`. It has to be a
 * shell script, not the compiled binary it replaced, because only the shell can
 * set the tty raw, hand the device path to LaunchServices, wait, and put the tty
 * back. The app it launches cannot be a child: `open -n -W` starts a new instance
 * through LaunchServices and always exits 0, so the exit code can only come back
 * through `--exit-file`.
 *
 * That is why this file asserts two different things:
 *
 *  - the SHAPE the build installs (a shell wrapper, and an app bundle with the
 *    right identifiers); and
 *  - the BEHAVIOUR on a real pty — the picker draws on the device and Esc
 *    cancels it, and a refusal's exit code reaches the caller even though `open`
 *    itself reported success.
 *
 * The wrapper's own `stty`, its `--tty` handover and its `--exit-file` are proven
 * by those runs, never by grepping the script for the words: a grep for `stty`
 * passes on a comment, and passes on a script that would never set a terminal raw.
 *
 * The pty comes from `Bun.Terminal`, bun's own terminal API: no second language,
 * no external process. The slave device path is learned by running `tty` on that
 * pty and reading the first `/dev/` line it prints. Nothing here is asserted on
 * how the screen looked; a picker is a byte stream, and a redraw looks broken to
 * a grep.
 */

const hasPty = typeof Bun.Terminal === 'function'
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

// A required gate treats SKIP as failure. The two pty tests below are
// `skipIf(!hasPty)`, so on a runtime without Bun.Terminal they skip and this file
// stays green with the wrapper's raw mode, its device handover and its exit-code
// propagation all unproven. This is the assertion that makes that a red instead.
test('Bun.Terminal is present, so the pty tests below run rather than skip', () => {
  expect(hasPty, 'Bun.Terminal is absent; every pty test below would skip and stay green').toBe(
    true
  )
})

/** A shell script starts with `#!`; the compiled binary this replaces does not. */
async function isWrapper(path: string): Promise<boolean> {
  const f = Bun.file(path)
  if (!(await f.exists())) return false
  return (await f.slice(0, 2).text()) === '#!'
}

/** One key of the bundle's Info.plist, or "" when the file or the key is absent. */
async function plistValue(key: string): Promise<string> {
  if (!(await Bun.file(PLIST).exists())) return ''
  const p = Bun.spawnSync(['/usr/bin/plutil', '-extract', key, 'raw', PLIST], {
    timeout: 10000,
    killSignal: 'SIGTERM'
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : ''
}

type Term = {
  readonly terminal: Bun.Terminal
  read(): string
  reset(): void
}

/** One pty, with everything the child writes collected as text. */
function makeTerminal(): Term {
  let out = ''
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 40,
    data(_t, chunk) {
      out += decoder.decode(chunk)
    }
  })
  return {
    terminal,
    read: () => out,
    reset: () => {
      out = ''
    }
  }
}

/**
 * The slave device path of `t`: run `tty` on it and read the first `/dev/` line.
 * The probe is killed once the path is known; the pty stays open, so the same
 * device is what the wrapper will resolve and the app will open.
 */
async function slaveDevice(t: Term, ms = 5000): Promise<string> {
  const probe = Bun.spawn(['/bin/sh', '-c', 'tty; sleep 30'], { terminal: t.terminal })
  try {
    const start = Date.now()
    for (;;) {
      const match = t.read().match(/\/dev\/[^\s\r\n]+/)
      if (match) return match[0] as string
      if (Date.now() - start > ms) throw new Error('no /dev/ line from `tty` on the probe pty')
      await Bun.sleep(50)
    }
  } finally {
    // The probe is done with. Its exit is raced rather than awaited: a `sleep 30`
    // that outlives the SIGTERM would otherwise hold this test file open, and the
    // pty is closed by the caller either way.
    probe.kill()
    await Promise.race([probe.exited, Bun.sleep(2000)])
  }
}

type Run = { exited: boolean; code: number | null; output: string }

/**
 * Wait until the terminal has shown `marker`, or fail naming what it showed
 * instead. A sleep before a keystroke is a guess at how long the child needs —
 * too short and the key lands on a program that is not listening yet, which
 * reads as a product bug. This waits exactly as long as it takes, and no longer.
 */
async function waitFor(t: Term, marker: string, ms: number): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (t.read().replace(ANSI, '').includes(marker)) return
    if (Date.now() - start > ms) {
      throw new Error(
        `the terminal never showed ${JSON.stringify(marker)}: it showed ${JSON.stringify(
          t.read().replace(ANSI, '').slice(-500)
        )}`
      )
    }
    await Bun.sleep(25)
  }
}

/**
 * Run the wrapper on `t`, typing `steps` as `[textToWaitFor, keys]` pairs: each
 * keystroke goes in once the child has drawn what the step waits for.
 * `cwd` is the directory a person is standing in when they type the command.
 */
async function drive(
  t: Term,
  args: string[],
  steps: [string, string][],
  ms = 30000,
  cwd?: string
): Promise<Run> {
  t.reset()
  const proc = Bun.spawn([WRAPPER, ...args], {
    terminal: t.terminal,
    env: { ...Bun.env, TERM: 'xterm-256color' },
    ...(cwd === undefined ? {} : { cwd })
  })
  for (const [marker, keys] of steps) {
    await waitFor(t, marker, ms)
    // A finished program has no terminal left to type into.
    if (proc.exitCode === null) t.terminal.write(keys)
  }
  const raced = await Promise.race([proc.exited, Bun.sleep(ms).then(() => 'hung' as const)])
  if (raced === 'hung') {
    proc.kill()
    return { exited: false, code: null, output: t.read() }
  }
  await Bun.sleep(150) // let the last frame land before the terminal closes
  return { exited: true, code: raced, output: t.read() }
}

test('the build installs ~/bin/docnamer as a wrapper and assembles the app bundle', async () => {
  expect(
    await Bun.file(WRAPPER).exists(),
    `no wrapper at ${WRAPPER} — run \`bun run build\` to install one`
  ).toBe(true)

  const shebang = await Bun.file(WRAPPER).slice(0, 2).text()
  expect(
    shebang,
    `${WRAPPER} is not a shell wrapper: its first bytes are ${JSON.stringify(shebang)}`
  ).toBe('#!')

  expect(
    await Bun.file(BINARY).exists(),
    `no app binary at ${BINARY} — run \`bun run build\` to install one`
  ).toBe(true)
  expect(await plistValue('CFBundleIdentifier'), 'the bundle id must be com.tom.docnamer').toBe(
    'com.tom.docnamer'
  )
  expect(await plistValue('CFBundleName'), 'the display name must be docnamer').toBe('docnamer')
})

test.skipIf(!hasPty)(
  'the wrapper drives the picker through a real open on a real pty and propagates the exit code',
  async () => {
    if (!(await isWrapper(WRAPPER))) {
      expect(
        false,
        `no wrapper installed at ${WRAPPER}: found ${
          (await Bun.file(WRAPPER).exists()) ? 'a non-wrapper file' : 'nothing'
        }`
      ).toBe(true)
      return
    }

    const t = makeTerminal()
    try {
      const device = await slaveDevice(t)
      expect(device.startsWith('/dev/'), `the probe pty reported ${device}`).toBe(true)

      // The picker draws on the device and Esc cancels it: the prompt comes back.
      const login = await drive(t, ['login'], [['Sign in to a provider', '\x1b']])
      expect(
        login.exited,
        `a cancelled login must return, not hold the terminal open — the terminal showed head=${JSON.stringify(
          login.output.replace(ANSI, '').slice(0, 400)
        )} tail=${JSON.stringify(login.output.replace(ANSI, '').slice(-400))}`
      ).toBe(true)
      expect(login.code, 'a cancelled picker exits 0').toBe(0)
      expect(
        login.output.replace(ANSI, ''),
        'the picker must draw its title on the device'
      ).toContain('Sign in to a provider')

      // A refusal's exit code reaches the caller. `open -W` exits 0 whatever the
      // app does, so only --exit-file can carry the 2 back — the whole point of it.
      const refused = await drive(t, ['nonsense-command'], [])
      expect(refused.exited, 'the app must exit').toBe(true)
      expect(refused.code, 'the app exit code must propagate through open and the wrapper').toBe(2)
    } finally {
      t.terminal.close()
    }
  },
  90000
)

/** A throwaway folder to stand in, with nothing in it but the hidden marker. */
async function freshFolder(): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-rel-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, '')
  return dir
}

test.skipIf(!hasPty)(
  'a relative folder means the folder the person was standing in, not the app bundle',
  async () => {
    if (!(await isWrapper(WRAPPER))) {
      expect(false, `no wrapper installed at ${WRAPPER}`).toBe(true)
      return
    }

    // A LaunchServices launch gives the app cwd "/" — measured by `open -n`ing a
    // probe app from a known directory and reading back what it reported. So `plan .`
    // only means the folder the person typed it in if the wrapper carries that cwd
    // across to the app. An empty folder is the cheap proof: nothing to read, no
    // model call, and the plan it writes lands where the person was standing.
    const dir = await freshFolder()
    const t = makeTerminal()
    try {
      const run = await drive(t, ['plan', '.'], [], 30000, dir)
      const seen = run.output.replace(ANSI, '')
      expect(
        run.exited,
        `\`plan .\` must return — the terminal showed head=${JSON.stringify(
          seen.slice(0, 300)
        )} tail=${JSON.stringify(seen.slice(-300))}`
      ).toBe(true)
      expect(
        run.code,
        `\`plan .\` in an empty folder plans zero rows and exits 0 — the terminal said ${JSON.stringify(
          seen.slice(0, 500)
        )}`
      ).toBe(0)
      expect(
        await Bun.file(`${dir}/${PLAN_FILE}`).exists(),
        `\`plan .\` wrote no plan into ${dir}, the folder the wrapper ran in: the app resolved "." against ${
          seen.includes('/') ? `a path outside it` : 'nothing'
        } — terminal said ${JSON.stringify(seen.slice(0, 400))}`
      ).toBe(true)
    } finally {
      t.terminal.close()
    }
  },
  60000
)
