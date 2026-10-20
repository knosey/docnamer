import { expect, test } from 'bun:test'
import { appBin as BINARY, appPlist as PLIST, wrapper as WRAPPER } from './app-binary.ts'
import { PLAN_FILE } from '../src/commands.ts'
import { staleInstall } from './doc-renamer-apply-harness.ts'
import { ANSI, drive, hasPty, makeTerminal, slaveDevice } from './pty.ts'
import { scratch } from './scratch.ts'

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
 * The pty comes from `Bun.Terminal`, bun's own terminal API, through the driver
 * in `tests/pty.ts` that this file shares with `pty.test.ts`: the terminal, the
 * wait-until-the-child-has-drawn-it and the deadline on the exit are the same
 * three things in both files, and one copy of them cannot drift. Nothing here is
 * asserted on how the screen looked; a picker is a byte stream, and a redraw
 * looks broken to a grep.
 */

/** The terminal a person has: a colour-capable one, and the environment as it
 *  is (the wrapper's own behaviour is what is under test, not a scrubbed env). */
const wrapperEnv: Record<string, string> = { ...Bun.env, TERM: 'xterm-256color' } as Record<
  string,
  string
>

// A required gate treats SKIP as failure. The two pty tests below are
// `skipIf(!hasPty)`, so on a runtime without Bun.Terminal they skip and this file
// stays green with the wrapper's raw mode, its device handover and its exit-code
// propagation all unproven. This is the assertion that makes that a red instead.
test('Bun.Terminal is present, so the pty tests below run rather than skip', () => {
  expect(hasPty, 'Bun.Terminal is absent; every pty test below would skip and stay green').toBe(
    true
  )
})

// The wrapper and the bundle are whatever `bun run build` last wrote, so driving
// them says nothing about the tree that just changed unless the build came from
// this tree and nothing has moved since. `staleInstall` reads the record the
// build writes and compares it against the sources.
test('the installed wrapper and bundle were built from this tree', async () => {
  const stale = await staleInstall()
  expect(stale, `the installed artifacts are not this tree's: ${stale}`).toBe(null)
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
      const login = await drive(t, [WRAPPER, 'login'], [['Sign in to a provider', '\x1b']], {
        env: wrapperEnv,
        ms: 90000
      })
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
      const refused = await drive(t, [WRAPPER, 'nonsense-command'], [], {
        env: wrapperEnv,
        ms: 90000
      })
      expect(refused.exited, 'the app must exit').toBe(true)
      expect(refused.code, 'the app exit code must propagate through open and the wrapper').toBe(2)
    } finally {
      t.terminal.close()
    }
  },
  90000
)

/**
 * `open -W` can lose the race it exists to win: when the app exits before `open`
 * registers its wait, it prints "Unable to block on applications (initial call to
 * kevent() failed: No such process)" and exits 1. Measured once in a full
 * `bun run test:free`: a `plan .` that had already written its plan reached the
 * shell as 1, and 1 is the code reserved for a run that was accepted and then
 * failed — a successful run reported as a failure is the one thing the wrapper
 * must never do. `--version` is the fastest real command there is, so it is what
 * races here: twelve runs, and every one must come back with the app's own 0.
 */
test.skipIf(!hasPty)(
  'the wrapper returns the app exit code even when open cannot block on the app',
  async () => {
    if (!(await isWrapper(WRAPPER))) {
      expect(false, `no wrapper installed at ${WRAPPER}`).toBe(true)
      return
    }

    const t = makeTerminal()
    try {
      for (const n of Array.from({ length: 12 }, (_, i) => i + 1)) {
        const run = await drive(t, [WRAPPER, '--version'], [], { env: wrapperEnv })
        const seen = run.output.replace(ANSI, '')
        expect(run.exited, `run ${n}: the app must exit`).toBe(true)
        expect(
          run.code,
          `run ${n}: the app ran and exited 0, so the wrapper must return 0 — the terminal said ${JSON.stringify(
            seen.slice(0, 400)
          )}`
        ).toBe(0)
        expect(seen, `run ${n}: the app must have answered --version`).toContain('docnamer')
      }
    } finally {
      t.terminal.close()
    }
  },
  120000
)

/** A throwaway folder to stand in, with nothing in it but the hidden marker. */
async function freshFolder(): Promise<string> {
  const dir = scratch('docnamer-rel')
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
      const run = await drive(t, [WRAPPER, 'plan', '.'], [], { env: wrapperEnv, cwd: dir })
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

/**
 * The wrapper sets the tty raw so the app can read keys off the device, and
 * `stty raw` on macOS also clears `opost`: output processing off, so a `\n` the
 * app writes moves the cursor down without returning it to column 0. Every
 * plain-text command — `--help` most visibly — then staircases across the
 * screen. pi-tui's own raw mode (libuv's `setRawMode`) leaves output processing
 * on; the wrapper must do the same. The bytes are read before any line split,
 * because `paints()` splits on `\r\n|\n|\r` and so cannot tell the two apart.
 */
test.skipIf(!hasPty)(
  'every line the app writes through the wrapper returns to column 0',
  async () => {
    if (!(await isWrapper(WRAPPER))) {
      expect(false, `no wrapper installed at ${WRAPPER}`).toBe(true)
      return
    }

    const t = makeTerminal()
    try {
      const run = await drive(t, [WRAPPER, '--help'], [], { env: wrapperEnv })
      expect(run.exited, 'the app must exit').toBe(true)
      expect(run.code, '--help exits 0').toBe(0)
      const bare = run.output.match(/(?<!\r)\n/g)?.length ?? 0
      expect(
        bare,
        `${bare} line feeds reached the terminal without a carriage return — the tty's output processing is off: ${JSON.stringify(
          run.output.replace(ANSI, '').slice(0, 300)
        )}`
      ).toBe(0)
    } finally {
      t.terminal.close()
    }
  },
  60000
)
