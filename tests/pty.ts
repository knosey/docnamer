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

export const hasPty = typeof Bun.Terminal === 'function'

/** The escape sequences a terminal interprets, so a captured frame can be read
 *  as the text a person actually sees on it. */
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

export type Term = {
  readonly terminal: Bun.Terminal
  read(): string
  reset(): void
}

/**
 * One pty, with everything the child writes collected as text.
 *
 * The pty also plays the part of the terminal a person sits at: it tracks the
 * cursor (printable bytes advance the column; CR, LF and BS and the CSI
 * H/A/B/C/D/G/d sequences move it, clamped to the box) and answers each DSR
 * query (`ESC[6n`) once with `ESC[{row};{col}R` on the child's input, because
 * a real terminal answers. The limit, measured byte-for-byte on this pty: zsh
 * prints its inverse `%` promptsp marker plus its erase sequence after EVERY
 * command even with the answer, so the marker's absence is a fact about the
 * SCREEN, not the byte log — the screen model of terminal-ux-polish's T1 task
 * is what observes it.
 */
export function makeTerminal(cols = 100, rows = 40): Term {
  let out = ''
  const decoder = new TextDecoder()
  const esc = String.fromCharCode(27)
  const csi = new RegExp(`${esc}\\[([0-9;?]*)([A-Za-z])`, 'y')
  let row = 0
  let col = 0
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(v, hi))
  /** The `at`-th CSI parameter, 1 when absent: `ESC[C` moves one column. */
  const param = (params: string, at: number): number => {
    const p = params.split(';')[at]
    return p === undefined || p === '' ? 1 : Number(p)
  }
  /** One CSI final byte as the cursor move it commands (`f` is `H`). */
  const CSI_MOVE: Record<string, (n: (at: number) => number) => void> = {
    H: n => {
      row = clamp(n(0) - 1, rows - 1)
      col = clamp(n(1) - 1, cols - 1)
    },
    A: n => {
      row = clamp(row - n(0), rows - 1)
    },
    B: n => {
      row = clamp(row + n(0), rows - 1)
    },
    C: n => {
      col = clamp(col + n(0), cols - 1)
    },
    D: n => {
      col = clamp(col - n(0), cols - 1)
    },
    G: n => {
      col = clamp(n(0) - 1, cols - 1)
    },
    d: n => {
      row = clamp(n(0) - 1, rows - 1)
    }
  }
  /** One control byte as the cursor move it commands; a printable advances. */
  const CONTROL_MOVE: Record<string, () => void> = {
    '\r': () => {
      col = 0
    },
    '\n': () => {
      row = clamp(row + 1, rows - 1)
    },
    '\x08': () => {
      col = clamp(col - 1, cols - 1)
    }
  }
  /** Apply one CSI sequence: answer a DSR query, move the cursor otherwise. */
  const applyCsi = (params: string, f: string, answer: (reply: string) => void): void => {
    if (f === 'n' && params === '6') {
      answer(`${esc}[${row + 1};${col + 1}R`)
      return
    }
    CSI_MOVE[f === 'f' ? 'H' : f]?.(at => param(params, at))
  }
  /** Advance the tracked cursor over one chunk of child output. */
  const track = (text: string, answer: (reply: string) => void): void => {
    let i = 0
    while (i < text.length) {
      if (text[i] === esc && text[i + 1] === '[') {
        csi.lastIndex = i
        const m = csi.exec(text)
        if (m === null) return // a sequence split across chunks; the tail is untracked
        applyCsi(m[1] as string, m[2] as string, answer)
        i += m[0].length
        continue
      }
      const ch = text[i] as string
      if (ch >= ' ') col = clamp(col + 1, cols - 1)
      else CONTROL_MOVE[ch]?.()
      i++
    }
  }
  const terminal = new Bun.Terminal({
    cols,
    rows,
    data(t, chunk) {
      const text = decoder.decode(chunk)
      out += text
      track(text, reply => t.write(reply))
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
 * Wait until the terminal has shown `marker`, or fail naming what it showed
 * instead. This is the wait that replaces a sleep: it costs what the child
 * actually needs and no more.
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
