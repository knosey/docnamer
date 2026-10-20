// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? 'which open'

import { expect, test } from 'bun:test'

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
 *  - the SHAPE the build installs (a shell wrapper that launches through the
 *    `open` this machine has, an app bundle with the right identifiers); and
 *  - the BEHAVIOUR on a real pty — the picker draws on the device and Esc
 *    cancels it, and a refusal's exit code reaches the caller even though `open`
 *    itself reported success.
 *
 * The pty comes from `Bun.Terminal`, bun's own terminal API: no second language,
 * no external process. The slave device path is learned by running `tty` on that
 * pty and reading the first `/dev/` line it prints. Nothing here is asserted on
 * how the screen looked; a picker is a byte stream, and a redraw looks broken to
 * a grep.
 */

const home = Bun.env.HOME ?? ''
const WRAPPER = `${home}/bin/docnamer`
const APP = `${home}/Applications/docnamer.app`
const BINARY = `${APP}/Contents/MacOS/docnamer`
const PLIST = `${APP}/Contents/Info.plist`

const hasPty = typeof Bun.Terminal === 'function'
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/** The `open` this machine has, straight from the reference command. */
async function openBinary(): Promise<string> {
  const p = Bun.spawn(['/bin/sh', '-c', reference], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) throw new Error(`reference \`${reference}\` exited ${code}`)
  return out.trim()
}

/** A shell script starts with `#!`; the compiled binary this replaces does not. */
async function isWrapper(path: string): Promise<boolean> {
  const f = Bun.file(path)
  if (!(await f.exists())) return false
  return (await f.slice(0, 2).text()) === '#!'
}

/** One key of the bundle's Info.plist, or "" when the file or the key is absent. */
async function plistValue(key: string): Promise<string> {
  if (!(await Bun.file(PLIST).exists())) return ''
  const p = Bun.spawn(['/usr/bin/plutil', '-extract', key, 'raw', PLIST], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out.trim() : ''
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
    probe.kill()
    await probe.exited
  }
}

type Run = { exited: boolean; code: number | null; output: string }

/** Run the wrapper on `t`, typing `steps` as `[secondsToWait, keys]` pairs. */
async function drive(t: Term, args: string[], steps: [number, string][], ms = 30000): Promise<Run> {
  t.reset()
  const proc = Bun.spawn([WRAPPER, ...args], {
    terminal: t.terminal,
    env: { ...Bun.env, TERM: 'xterm-256color' }
  })
  for (const [wait, keys] of steps) {
    await Bun.sleep(wait * 1000)
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
  expect(await Bun.file(WRAPPER).exists(), `no wrapper at ${WRAPPER}`).toBe(true)

  const shebang = await Bun.file(WRAPPER).slice(0, 2).text()
  expect(
    shebang,
    `${WRAPPER} is not a shell wrapper: its first bytes are ${JSON.stringify(shebang)}`
  ).toBe('#!')

  const open = await openBinary()
  const openName = open.split('/').filter(Boolean).pop() ?? open
  const text = await Bun.file(WRAPPER).text()
  expect(text.includes('stty'), 'the wrapper must set the tty raw with stty').toBe(true)
  expect(text.includes('--tty'), 'the wrapper must hand the app the tty device path').toBe(true)
  expect(
    text.includes('--exit-file'),
    'the wrapper must pass --exit-file so the exit code can come back'
  ).toBe(true)
  expect(
    text.includes(open) || text.includes(openName),
    `the wrapper must launch through the open this machine has (${open})`
  ).toBe(true)

  expect(await Bun.file(BINARY).exists(), `no app binary at ${BINARY}`).toBe(true)
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
      const login = await drive(
        t,
        ['login'],
        [
          [1.5, '\x1b'],
          [0.5, 'x']
        ]
      )
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
