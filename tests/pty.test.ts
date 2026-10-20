import { expect, test } from 'bun:test'
import { repo, resolveCli, closedFolder, reopen } from './doc-renamer-apply-harness.ts'
import { ANSI, drive, hasPty, makeTerminal, paints } from './pty.ts'
import { scratch } from './scratch.ts'

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
 *
 * The pty, the wait-until-drawn and the exit deadline live in `tests/pty.ts`,
 * because `wrapper-pty.test.ts` needs exactly the same three.
 */

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
  const home = scratch('docnamer-pty')
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

/** The CLI this file drives, or a failure that says how to get one. */
async function cliOrThrow(): Promise<string[]> {
  const cli = await resolveCli()
  if (cli === null) {
    throw new Error('pty: no docnamer CLI to drive — build it or set DOCNAMER_BIN')
  }
  return cli
}

test.skipIf(!hasPty)(
  'the picker on a real pty picks, stores and returns the prompt',
  async () => {
    const cli = await cliOrThrow()
    const home = await freshHome()
    const t = makeTerminal()
    try {
      // Each keystroke waits for the frame that answers it: the list, then the
      // filter it applied, then the key prompt the choice opened.
      const run = await drive(
        t,
        [...cli, 'login'],
        [
          ['Sign in to a provider', 'fire'],
          ['filter: fire', '\r'],
          ['Enter Fireworks API key', 'key-from-the-pty\n']
        ],
        { cwd: repo, env: cleanEnv(home) }
      )
      const seen = run.output.replace(ANSI, '')

      expect(run.exited, 'login must return the prompt, not hold the terminal open').toBe(true)
      expect(run.code, 'a completed login exits 0').toBe(0)
      expect(seen, 'the picker must name the providers it is offering').toContain('Fireworks')
      expect(seen, 'the filter must narrow to the one provider it matched').toContain(
        'filter: fire'
      )
      expect(seen, 'login must say where the credential went').toContain(
        'stored in ~/.config/docnamer/credentials.json'
      )

      const store = JSON.parse(await Bun.file(`${home}/.config/docnamer/credentials.json`).text())
      expect(store.fireworks, 'the picked provider is the one that was stored').toEqual({
        type: 'api_key',
        key: 'key-from-the-pty'
      })
    } finally {
      t.terminal.close()
    }
  },
  20000
)

test.skipIf(!hasPty)(
  'escape cancels the picker on a real pty and still returns the prompt',
  async () => {
    const cli = await cliOrThrow()
    const home = await freshHome()
    const t = makeTerminal()
    try {
      const run = await drive(t, [...cli, 'login'], [['Sign in to a provider', '\x1b']], {
        cwd: repo,
        env: cleanEnv(home)
      })
      const seen = run.output.replace(ANSI, '')

      expect(run.exited, 'a cancelled picker must return the prompt too').toBe(true)
      expect(run.code, 'cancelling is not a crash').toBe(0)
      expect(seen, 'a cancelled login must not claim a provider was signed in').not.toContain(
        'signed in to'
      )
      expect(
        await Bun.file(`${home}/.config/docnamer/credentials.json`).exists(),
        'nothing may be stored by a cancelled picker'
      ).toBe(false)
    } finally {
      t.terminal.close()
    }
  },
  20000
)

/** How many rows the terminal used for `lines`: a line wider than the terminal
 *  is the terminal's to wrap, and a wrapped line costs a second row. */
function rows(lines: readonly string[], cols: number): number {
  return lines.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0)
}

/**
 * The frame must fit the terminal it is drawn on.
 *
 * On an 80-column terminal the picker drew a 104-column row — the signed-in
 * provider's status column, appended with no width budget — so the terminal
 * wrapped it, so the frame occupied 16 rows while the redraw moved up 15. Every
 * repaint after the first then left the screen one row out, which is a screen
 * that stays ragged until the program exits.
 *
 * Both assertions are about what the program DID: no drawn line is wider than
 * the terminal, and the redraw moves up by the ROWS the previous paint occupied
 * rather than by the lines it drew. The second is the one a wrapped line cannot
 * survive, and it is why the row count is computed from the drawn text instead of
 * from the array's length.
 */
test.skipIf(!hasPty)(
  'the picker fits the terminal it is drawn on and its redraw counts the rows the terminal used',
  async () => {
    const cli = await cliOrThrow()
    const home = await freshHome()
    // One provider already signed in, because the status column is what pushed a
    // row past the terminal's width: with nothing signed in there is no status
    // cell to overflow and this test would pass without proving anything.
    await Bun.write(
      `${home}/.config/docnamer/credentials.json`,
      JSON.stringify({ fireworks: { type: 'api_key', key: 'seeded' } })
    )
    const t = makeTerminal(80, 40)
    try {
      const run = await drive(
        t,
        [...cli, 'login'],
        [
          ['Sign in to a provider', '\x1b[B'],
          ['\u276f Ant Ling', '\x1b']
        ],
        { cwd: repo, env: cleanEnv(home) }
      )
      expect(run.exited, 'a cancelled picker must return the prompt').toBe(true)
      const seen = paints(run.output)
      expect(
        seen.length,
        'the Down must have forced a second paint, or nothing here redraws'
      ).toBeGreaterThanOrEqual(2)
      expect(
        seen[0]?.lines.join('\n'),
        'the seeded provider must show where its key is, or no row in this frame can overflow'
      ).toContain('signed in')

      const over = seen.flatMap((paint, i) =>
        paint.lines
          .filter(line => line.length > 80)
          .map(line => `paint ${i + 1}: ${line.length} > 80: ${line}`)
      )
      const used = rows(seen[0]?.lines ?? [], 80)
      const moved = seen[1]?.up
      const problems = [...over]
      if (moved !== used) {
        problems.push(
          `redraw moved up ${String(moved)} rows where the terminal used ${used} for ${String(seen[0]?.lines.length)} drawn lines`
        )
      }
      expect(
        problems,
        'the frame is drawn without a width budget: a line wider than the terminal wraps, and the redraw then counts the lines drawn where the terminal counted rows'
      ).toEqual([])
    } finally {
      t.terminal.close()
    }
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
    const cli = await cliOrThrow()
    const home = await freshHome()
    const closed = await closedFolder()
    const t = makeTerminal()
    try {
      const run = await drive(t, [...cli, 'plan', closed], [], { cwd: repo, env: cleanEnv(home) })

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
      t.terminal.close()
      await reopen(closed)
    }
  },
  20000
)

/**
 * The review screen on a terminal is driven by keys, and a key is a sequence,
 * not a byte. Review read one byte at a time, so ↑ (`ESC [ A`) ended on `A` —
 * accept every unflagged row — and `e` read its name off the rest of the read,
 * which on a terminal is empty: "applyAction: edit needs the new name as its
 * value". Ctrl-C was a byte nobody handled, so the review could not be left.
 *
 * Here ↓ and ↑ move between rows and decide nothing, the edit line takes Home
 * and End, Esc leaves a row as it was, and Ctrl-C saves and quits.
 */
test.skipIf(!hasPty)(
  'the review screen moves, edits and quits by key on a real pty',
  async () => {
    const cli = await cliOrThrow()
    const home = await freshHome()
    const folder = scratch('docnamer-pty-review')
    const planRow = (old: string) => ({
      old,
      new: `2024-03-12 ${old}`,
      type: 'receipt',
      method: 'text',
      fields: { date: '2024-03-12' },
      evidence: { date: 'Date 12 March 2024' },
      flags: [],
      summary: `A receipt named ${old}.`,
      size: 10,
      mtime: 0,
      status: 'pending'
    })
    await Bun.write(
      `${folder}/.docnamer-plan.json`,
      JSON.stringify(
        [planRow('a-receipt.pdf'), planRow('b-receipt.pdf'), planRow('c-receipt.pdf')],
        null,
        2
      )
    )
    const t = makeTerminal()
    try {
      const run = await drive(
        t,
        [...cli, 'review', folder],
        [
          ['[1/3]', '\x1b[B'],
          // ↑ then `e`: the edit opens on the row ↑ moved back to.
          ['[2/3]', '\x1b[Ae'],
          // Home, a prefix, End, four backspaces off ".pdf", and a suffix with a
          // space in it.
          ['new name: 2024-03-12 a-receipt.pdf', '\x1b[HX \x1b[F\x7f\x7f\x7f\x7f fixed.pdf\r'],
          // One write: the Esc reaches the review in the read that carried the
          // `e`, before the line it cancels was drawn.
          ['X 2024-03-12 a-receipt fixed.pdf', 'e\x1b'],
          ['unchanged', '\x03']
        ],
        { cwd: repo, env: cleanEnv(home), ms: 8000 }
      )
      const seen = run.output.replace(ANSI, '')
      expect(
        run.exited,
        `Ctrl-C must leave the review — the terminal showed ${JSON.stringify(seen.slice(-400))}`
      ).toBe(true)
      expect(
        run.code,
        `review exits 0 — the terminal showed ${JSON.stringify(seen.slice(-400))}`
      ).toBe(0)

      expect(
        run.output.includes('\x1b_'),
        "pi-tui's cursor markers are its renderer's to resolve; raw, they reach the terminal"
      ).toBe(false)

      const after: { new: string; status: string }[] = JSON.parse(
        await Bun.file(`${folder}/.docnamer-plan.json`).text()
      )
      expect(after[0], 'the edited name is the one stored, and the row is accepted').toEqual(
        expect.objectContaining({ new: 'X 2024-03-12 a-receipt fixed.pdf', status: 'accepted' })
      )
      expect(after[1], 'an edit cancelled with Esc changes nothing').toEqual(
        expect.objectContaining({ new: '2024-03-12 b-receipt.pdf', status: 'pending' })
      )
      expect(after[2], 'an arrow key decides nothing: ↑ is not `A`').toEqual(
        expect.objectContaining({ status: 'pending' })
      )
    } finally {
      t.terminal.close()
    }
  },
  20000
)
