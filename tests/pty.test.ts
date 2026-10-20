import { expect, test } from 'bun:test'
import { repo, resolveCli, closedFolder, reopen } from './doc-renamer-apply-harness.ts'

/**
 * T9 — `docnamer login` on a REAL terminal.
 *
 * The picker is the one part of the CLI a pipe cannot reach: `pick` routes to a
 * numbered list whenever stdin is not a tty, so every other test exercises the
 * fallback and leaves the arrow picker, its raw mode and its in-place redraw
 * unproven. This file gives the program a real pty (`Bun.Terminal`, the
 * terminal API built into bun — no external process, no second language) and
 * drives the keys a person would press.
 *
 * It asserts on what the program DID, never on how the screen looked: that it
 * picked the provider the filter left on screen, that it stored the credential
 * where it says it did, and — the assertion a screenshot cannot make — that it
 * EXITED. A reader left holding Bun's stdin stream keeps the process alive
 * forever, which prints a perfect success line and then never returns the
 * prompt; only the exit status catches that.
 */

/** How long the child gets to exit on its own before it counts as a hang. */
const EXIT_MS = 4000

/** The escape sequences a terminal interprets, so a captured frame can be read
 *  as the text a person actually sees on it. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const hasPty = typeof Bun.Terminal === 'function'

// A required gate treats SKIP as failure. Three of this file's tests are
// `skipIf(!hasPty)`, so on a runtime without Bun.Terminal the file empties itself
// and the suite stays green with the arrow picker, its raw mode and its redraw all
// unproven. This is the assertion that makes that a red instead.
test('Bun.Terminal is present, so the pty tests below run rather than skip', () => {
  expect(hasPty, 'Bun.Terminal is absent; every pty test below would skip and stay green').toBe(
    true
  )
})

/** A throwaway home with nothing signed in, one per test: a credential written
 *  by one test must never be visible to the next. */
async function freshHome(): Promise<string> {
  const home = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-pty-${crypto.randomUUID()}`
  await Bun.write(`${home}/.keep`, '')
  return home
}

/** The environment a person has on a fresh machine: no key in the environment,
 *  no pi credential file, nothing signed in yet. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env.HOME = home
  env.TERM = 'xterm-256color'
  delete env.NO_COLOR
  delete env.FIREWORKS_API_KEY
  delete env.XDG_CONFIG_HOME
  return env
}

type Run = { exited: boolean; code: number | null; output: string }

async function drive(cmd: string[], steps: [number, string][], home: string): Promise<Run> {
  let output = ''
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 40,
    data(_t, chunk) {
      output += decoder.decode(chunk)
    }
  })

  const proc = Bun.spawn(cmd, { cwd: repo, terminal, env: cleanEnv(home) })
  try {
    for (const [wait, keys] of steps) {
      await Bun.sleep(wait * 1000)
      // A finished program has no terminal left to type into.
      if (proc.exitCode === null) terminal.write(keys)
    }
    const raced = await Promise.race([proc.exited, Bun.sleep(EXIT_MS).then(() => 'hung' as const)])
    if (raced === 'hung') {
      proc.kill()
      return { exited: false, code: null, output }
    }
    await Bun.sleep(100) // let the last frame land before the terminal closes
    return { exited: true, code: raced, output }
  } finally {
    terminal.close()
  }
}

test.skipIf(!hasPty)(
  'the picker on a real pty picks, stores and returns the prompt',
  async () => {
    const cli = await resolveCli()
    if (cli === null) {
      throw new Error('pty: no docnamer CLI to drive — build it or set DOCNAMER_BIN')
    }
    const home = await freshHome()

    const run = await drive(
      [...cli, 'login'],
      [
        [0.8, 'fire'],
        [0.3, '\r'],
        [0.7, 'key-from-the-pty\n']
      ],
      home
    )

    expect(run.exited, 'login must return the prompt, not hold the terminal open').toBe(true)
    expect(run.code, 'a completed login exits 0').toBe(0)
    expect(run.output, 'the picker must name the providers it is offering').toContain('Fireworks')
    expect(run.output, 'the filter must narrow to the one provider it matched').toContain(
      'filter: fire'
    )
    expect(run.output, 'login must say where the credential went').toContain(
      'stored in ~/.config/docnamer/credentials.json'
    )

    const store = JSON.parse(await Bun.file(`${home}/.config/docnamer/credentials.json`).text())
    expect(store.fireworks, 'the picked provider is the one that was stored').toEqual({
      type: 'api_key',
      key: 'key-from-the-pty'
    })
  },
  20000
)

test.skipIf(!hasPty)(
  'escape cancels the picker on a real pty and still returns the prompt',
  async () => {
    const cli = await resolveCli()
    if (cli === null) {
      throw new Error('pty: no docnamer CLI to drive — build it or set DOCNAMER_BIN')
    }

    const home = await freshHome()

    const run = await drive(
      [...cli, 'login'],
      [
        [0.8, '\x1b'],
        [0.3, 'x']
      ],
      home
    )

    expect(run.exited, 'a cancelled picker must return the prompt too').toBe(true)
    expect(run.code, 'cancelling is not a crash').toBe(0)
    expect(run.output, 'a cancelled login must not claim a provider was signed in').not.toContain(
      'signed in to'
    )
    expect(
      await Bun.file(`${home}/.config/docnamer/credentials.json`).exists(),
      'nothing may be stored by a cancelled picker'
    ).toBe(false)
  },
  20000
)

/**
 * The frame a failure must not be glued to.
 *
 * `stop` clears the spinner's line with a carriage return and an erase, so a command that throws must
 * stop the spinner before the error is written or the error lands on the end of the frame:
 *
 *   ⠋ reading . and asking the modeldocnamer: EPERM: operation not permitted, open '.'
 *
 * A pipe cannot show this: with no line to return to the spinner writes the label once and the error
 * follows on its own line, which is why the assertion lives here, on a real terminal.
 */
test.skipIf(!hasPty)(
  'a failure under a spinner lands on its own line, not on the frame',
  async () => {
    const cli = await resolveCli()
    if (cli === null) {
      throw new Error('pty: no docnamer CLI to drive — build it or set DOCNAMER_BIN')
    }
    const home = await freshHome()
    const closed = await closedFolder()

    try {
      const run = await drive([...cli, 'plan', closed], [], home)

      expect(run.exited, 'a refused folder must still return the prompt').toBe(true)
      expect(run.code, 'a refused folder is a failed run').toBe(1)
      // The frame is redrawn in place, so a line that BEGINS with the program's
      // name is the failure standing alone; glued, the frame's label runs into
      // it and no line starts there.
      const lines = run.output.replace(ANSI, '').split(/[\r\n]/)
      expect(
        lines.some(line => line.startsWith('docnamer:')),
        'the error was glued to the spinner frame: no line begins with docnamer:'
      ).toBe(true)
    } finally {
      await reopen(closed)
    }
  },
  20000
)
