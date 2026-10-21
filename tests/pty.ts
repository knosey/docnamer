/**
 * One driver for a real terminal, shared by every test that needs one.
 *
 * A pty test can only assert on what the program DID — it picked, it stored, it
 * exited — because a screen is a byte stream and a redraw looks broken to a
 * grep. Getting that stream means three things done right, and doing them twice
 * is how one of the two copies drifts:
 *
 *  - the terminal itself (`Bun.Terminal`, bun's own API: no external process);
 *  - waiting for what the child has drawn BEFORE typing at it. A sleep is a
 *    guess at how long the child needs, and a key typed into a program that is
 *    not listening yet reds the run for a reason that names nothing — which is
 *    what these files did until the review council named it;
 *  - a deadline on the exit, so a program that holds the terminal open fails the
 *    test instead of hanging the suite.
 *
 * Nothing here asserts anything. A file that uses it owns its own expectations.
 */

import xterm from '@xterm/headless'

export const hasPty = typeof Bun.Terminal === 'function'

/** The escape sequences a terminal interprets, so a captured frame can be read
 *  as the text a person actually sees on it. */
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

export type Term = {
  readonly terminal: Bun.Terminal
  /** Every byte the child wrote, as text: the log, not the screen. */
  read(): string
  /** The screen a person sees: the visible rows, right-trimmed, with the blank
   *  rows below the last written one dropped. Resolves once every byte written
   *  so far has been drawn. */
  screen(): Promise<string>
  reset(): void
}

/** The screen the emulated pty presents: the width every frame must fit. */
export const SCREEN_COLS = 100

/**
 * One pty, with everything the child writes collected as text and drawn on a
 * real terminal emulator: xterm.js, headless — the emulator pi-tui tests its
 * own renderer against. The screen is what a person sees, so it has to be kept
 * the way a terminal keeps it, and a hand-built grid did not: it clamped the
 * cursor at the right edge, so a line one character too wide overwrote the last
 * cell with its final character (`missing requ4`), and clamped at the bottom,
 * so a frame past the last row overwrote that row instead of scrolling. xterm
 * wraps, scrolls, erases, switches screens and answers the child's queries
 * (zsh's cursor-position query among them) as a terminal does.
 */
export function makeTerminal(cols = SCREEN_COLS, rows = 40): Term {
  let out = ''
  const decoder = new TextDecoder()
  const display = new xterm.Terminal({ cols, rows, allowProposedApi: true })
  const terminal = new Bun.Terminal({
    cols,
    rows,
    data(_t, chunk) {
      out += decoder.decode(chunk, { stream: true })
      display.write(chunk)
    }
  })
  // A terminal answers what it is asked; the replies go back on the child's input.
  display.onData(reply => terminal.write(reply))
  const visible = (): string => {
    const buffer = display.buffer.active
    const lines = Array.from(
      { length: rows },
      (_, r) => buffer.getLine(buffer.viewportY + r)?.translateToString(true) ?? ''
    )
    let last = lines.length - 1
    while (last >= 0 && lines[last] === '') last -= 1
    return lines.slice(0, last + 1).join('\n')
  }
  return {
    terminal,
    read: () => out,
    // xterm parses asynchronously: an empty write's callback runs once
    // everything before it has been drawn.
    screen: () => new Promise(resolve => display.write('', () => resolve(visible()))),
    reset: () => {
      out = ''
    }
  }
}

/**
 * Wait until the terminal has shown `marker` in the output written since byte
 * `from`, or fail naming what it showed instead. This is the wait that replaces
 * a sleep: it costs what the child actually needs and no more. `from` is where
 * the log stood when the keys this wait answers were typed: a marker already on
 * screen before them proves nothing about what they did.
 */
async function waitFor(t: Term, marker: string, ms: number, from = 0): Promise<void> {
  const start = Date.now()
  const since = (): string => t.read().slice(from).replace(ANSI, '')
  for (;;) {
    if (since().includes(marker)) return
    if (Date.now() - start > ms) {
      throw new Error(
        `the terminal never showed ${JSON.stringify(marker)}: it showed ${JSON.stringify(
          since().slice(-500)
        )}`
      )
    }
    await Bun.sleep(25)
  }
}

/**
 * The slave device path of `t`: run `tty` on it and read the first `/dev/` line.
 * `Bun.Terminal` does not expose the path, and the wrapper resolves its own
 * `tty` to this same device, so the probe is how a test can name it. The probe
 * is killed once the path is known; the pty stays open.
 */
export async function slaveDevice(t: Term, ms = 5000): Promise<string> {
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
    // that outlives the SIGTERM would otherwise hold the test file open, and the
    // pty is closed by the caller either way.
    probe.kill()
    await Promise.race([probe.exited, Bun.sleep(2000)])
  }
}

export type Run = { exited: boolean; code: number | null; output: string }

export type DriveOptions = {
  cwd?: string
  env?: Record<string, string>
  /** How long the child gets to exit on its own before it counts as a hang. */
  ms?: number
}

/**
 * Run `cmd` on `t`, typing `steps` as `[textToWaitFor, keys]` pairs: each
 * keystroke goes in once the child has drawn what the step waits for. `cwd` is
 * the directory a person is standing in when they type the command.
 */
export async function drive(
  t: Term,
  cmd: string[],
  steps: [string, string][],
  o: DriveOptions = {}
): Promise<Run> {
  const ms = o.ms ?? 30000
  t.reset()
  const proc = Bun.spawn(cmd, {
    terminal: t.terminal,
    ...(o.env === undefined ? {} : { env: o.env }),
    ...(o.cwd === undefined ? {} : { cwd: o.cwd })
  })
  let from = 0
  for (const [marker, keys] of steps) {
    await waitFor(t, marker, ms, from)
    from = t.read().length
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

/**
 * Every paint the picker wrote, in order: the up-count it issued before drawing
 * and the lines it drew, as the text a person sees. A paint is the frame between
 * one erase and the next, and the up-count of the paint that follows it is glued
 * to the end of the frame before it.
 */
export function paints(output: string): { up: number; lines: string[] }[] {
  const esc = String.fromCharCode(27)
  const held = new RegExp(`${esc}\\[([0-9]+)A$`)
  const bodies = output.split(`${esc}[J`).slice(1)
  const counted = bodies.map(body => {
    const found = body.match(held)
    return found === null ? null : Number(found[1])
  })
  return bodies.map((body, i) => {
    const up = counted[i]
    const text = up === null ? body : body.slice(0, body.length - `${esc}[${up}A`.length)
    return {
      up: i === 0 ? 0 : (counted[i - 1] as number),
      lines: text
        .replace(ANSI, '')
        .split(/\r\n|\n|\r/)
        .slice(0, -1)
    }
  })
}
