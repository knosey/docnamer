/**
 * The presentation layer: the one owner of every byte docnamer writes.
 *
 * Nothing else in the codebase calls console.log. A command asks for a line and
 * this decides what it looks like, which is what makes the ASCII fallback and
 * the no-colour-on-a-pipe rule hold everywhere at once instead of in the places
 * somebody remembered.
 *
 * Two rules here are load-bearing for other suites, not cosmetic:
 *
 *  - Colour off means ZERO escape sequences. tests/frame.ts rasterises PIPED
 *    stdout to build the frame the visual review reads; a stray ANSI code in
 *    that text corrupts the evidence rather than the appearance.
 *  - The margin of a row is emitted RAW, before any styling. The plan table's
 *    `!` marks the rows needing a decision, and a colour terminal must not be
 *    able to hide it from the reader or from a grep.
 */
import { deviceReader, deviceWriter } from './device.ts'

export type Style = {
  readonly colour: boolean
  readonly unicode: boolean
  readonly tty: boolean
}

const ESC = String.fromCharCode(27)

/**
 * Locale is a precedence chain, not a default: LC_ALL wins over LC_CTYPE wins
 * over LANG. A locale that is unset is not a missing value to paper over — it
 * is the common case on macOS, where the terminal is UTF-8 regardless.
 */
function locale(env: Record<string, string | undefined>): string | undefined {
  if (env.LC_ALL !== undefined && env.LC_ALL !== '') return env.LC_ALL
  if (env.LC_CTYPE !== undefined && env.LC_CTYPE !== '') return env.LC_CTYPE
  return env.LANG
}

function utf8(env: Record<string, string | undefined>): boolean {
  const value = locale(env)
  if (value === undefined || value === '') return true
  const lower = value.toLowerCase()
  return lower.includes('utf-8') || lower.includes('utf8')
}

export function styleFrom(env: Record<string, string | undefined>, tty: boolean): Style {
  return {
    colour: tty && !('NO_COLOR' in env) && env.TERM !== 'dumb',
    unicode: env.TERM !== 'dumb' && utf8(env),
    tty
  }
}

type Glyphs = {
  readonly ok: string
  readonly warn: string
  readonly pointer: string
  readonly rule: string
  readonly up: string
  readonly down: string
  readonly frames: readonly string[]
}

const UNICODE: Glyphs = {
  ok: '\u2713',
  warn: '!',
  pointer: '\u276f',
  rule: '\u2500',
  up: '\u2191',
  down: '\u2193',
  frames: [
    '\u280b',
    '\u2819',
    '\u2839',
    '\u2838',
    '\u283c',
    '\u2834',
    '\u2826',
    '\u2827',
    '\u2807',
    '\u280f'
  ]
}

const ASCII: Glyphs = {
  ok: '+',
  warn: '!',
  pointer: '>',
  rule: '-',
  up: '^',
  down: 'v',
  frames: ['|', '/', '-', '\\']
}

const INDENT = '  '
const GAP = '  '
const ERASE = `${ESC}[K`

/**
 * The terminal device the wrapper handed over, when it handed one.
 *
 * A LaunchServices-launched binary has no fd for the tty it was given, so the
 * device path is the only way in and out: `cli.ts` registers it at startup and
 * every byte below lands on it instead of the process's own stdout/stderr,
 * while `prompt.ts` reads its keys from the same path. With no device nothing
 * here changes.
 */
type Device = {
  readonly writer: { write(chunk: string): unknown; end(): unknown }
  readonly stream: ReadableStream<Uint8Array>
}

let active: Device | null = null

/** Register the device path as this process's terminal. */
export function setDevice(path: string): void {
  active = { writer: deviceWriter(path), stream: deviceReader(path) }
}

/** Whether a device is the terminal — prompt reads it instead of stdin. */
export function hasDevice(): boolean {
  return active !== null
}

/** The device's byte source, or null on the direct path. */
export function deviceStream(): ReadableStream<Uint8Array> | null {
  return active === null ? null : active.stream
}

/** Flush the device writer; the bytes must be on the path before exit. */
export async function closeDevice(): Promise<void> {
  await active?.writer.end()
}

/** Every write goes through here, so a test can capture the exact bytes. */
function write(text: string): void {
  if (active !== null) active.writer.write(text)
  else process.stdout.write(text)
}

/**
 * The other half of the same chokepoint: a failure is a different stream, and
 * keeping it here is what stops a command from reaching for console.error.
 * A device has one stream, so on a device a failure lands where success did.
 */
function writeErr(text: string): void {
  if (active !== null) active.writer.write(text)
  else process.stderr.write(text)
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

export type Row = readonly string[]
export type Spinner = {
  update(text: string): void
  /**
   * Ends the frame. `text` is the result line to leave behind, and is left out
   * when there is no result: a command that threw has none, and the frame it
   * drew still has to come off the line.
   */
  stop(text?: string): void
}

export type Ui = {
  readonly style: Style
  readonly glyphs: Glyphs
  head(title: string, detail?: string): string
  table(headers: Row, rows: readonly Row[]): string
  row(margin: string, cells: Row, widths?: readonly number[]): string
  note(text: string): string
  dim(text: string): string
  bold(text: string): string
  ok(text: string): string
  warn(text: string): string
  fail(what: string, help?: string): string
  spinner(label: string): Spinner
  /** A frame that positions the cursor writes its own bytes, and still does it here. */
  raw(text: string): void
  log(line: string): void
  err(line: string): void
}

/**
 * The frame sitting on the terminal's line, if one is.
 *
 * There is one terminal and one line, so this belongs to the module and not to
 * a `Ui`: cli.ts builds a second `Ui` to report a failure with, and it is that
 * instance which has to take the frame off — while `stop` runs on the success
 * path only, so a command that threw would otherwise leave its last frame for
 * the error to land on.
 */
let drawn: Spinner | null = null

export function ui(style: Style): Ui {
  const glyphs = style.unicode ? UNICODE : ASCII

  const tint = (code: string, text: string): string =>
    style.colour ? `${ESC}[${code}m${text}${ESC}[0m` : text
  const dim = (text: string): string => tint('2', text)
  const bold = (text: string): string => tint('1', text)
  const green = (text: string): string => tint('32', text)
  const yellow = (text: string): string => tint('33', text)
  const red = (text: string): string => tint('31', text)
  const cyan = (text: string): string => tint('36', text)

  /**
   * The shared layout primitive, and the only place a row is assembled. The
   * margin is a literal prefix emitted verbatim and FIRST, before any styling:
   * the plan table's `!` marks the rows needing a decision, and a colour
   * terminal must not be able to hide it from the reader or from a grep. Cells
   * are padded to `widths` when the caller has measured them, which is what
   * makes a column line up down the page rather than only across it.
   */
  function row(margin: string, cells: Row, widths?: readonly number[]): string {
    if (widths !== undefined && widths.length !== cells.length) {
      throw new Error(`ui.row: ${cells.length} cell(s) against ${widths.length} width(s)`)
    }
    const body = cells
      .map((cell, i) => (widths === undefined ? cell : pad(cell, widths[i] as number)))
      .join(GAP)
    return `${margin}${body}`.trimEnd()
  }

  function measure(headers: Row, rows: readonly Row[]): number[] {
    const widths: number[] = []
    for (let i = 0; i < headers.length; i += 1) {
      let w = (headers[i] as string).length
      for (const cells of rows) {
        if (cells.length !== headers.length) {
          throw new Error(`ui.table: ${cells.length} cell(s) against ${headers.length} column(s)`)
        }
        const cell = cells[i] as string
        if (cell.length > w) w = cell.length
      }
      widths.push(w)
    }
    return widths
  }

  return {
    style,
    glyphs,

    head(title: string, detail?: string): string {
      const text = detail === undefined ? title : `${title} ${dim('\u2014')} ${cyan(detail)}`
      const plain = detail === undefined ? title : `${title} \u2014 ${detail}`
      return `${INDENT}${bold(text)}\n${INDENT}${dim(glyphs.rule.repeat(plain.length))}`
    },

    row,

    table(headers: Row, rows: readonly Row[]): string {
      const widths = measure(headers, rows)
      const head = row(
        INDENT,
        headers.map(h => bold(h)),
        widths
      )
      const rule = row(
        INDENT,
        widths.map(w => glyphs.rule.repeat(w)),
        widths
      )
      const body = rows.map(cells => row(INDENT, cells, widths))
      return [head, rule, ...body].join('\n')
    },

    note: (text: string): string => `${INDENT}${dim(text)}`,
    dim,
    bold,
    ok: (text: string): string => `${INDENT}${green(glyphs.ok)} ${text}`,
    warn: (text: string): string => `${INDENT}${yellow(glyphs.warn)} ${text}`,

    fail(what: string, help?: string): string {
      // The failure is written where the frame is, so the frame comes off first.
      drawn?.stop()
      const first = `${red(bold('docnamer:'))} ${what}`
      return help === undefined ? first : `${first}\n${INDENT}${yellow('help:')} ${help}`
    },

    spinner(label: string): Spinner {
      // A pipe gets a log line and a result, never a redraw: there is no line to
      // return to, so a carriage return would only corrupt the log.
      if (!style.tty) {
        write(`${INDENT}${label}\n`)
        const piped: Spinner = {
          update: (): void => {},
          // Nothing to erase: the label went out as a log line and stays one.
          stop: (text?: string): void => {
            drawn = null
            if (text !== undefined) write(`${INDENT}${green(glyphs.ok)} ${text}\n`)
          }
        }
        drawn = piped
        return piped
      }
      let text = label
      let frame = 0
      const paint = (): void => {
        write(`\r${ERASE}${cyan(glyphs.frames[frame] as string)} ${text}`)
        frame = (frame + 1) % glyphs.frames.length
      }
      paint()
      const timer = setInterval(paint, 80)
      timer.unref()
      const live: Spinner = {
        update: (next: string): void => {
          text = next
        },
        stop: (final?: string): void => {
          clearInterval(timer)
          drawn = null
          write(`\r${ERASE}`)
          if (final !== undefined) write(`${INDENT}${green(glyphs.ok)} ${final}\n`)
        }
      }
      drawn = live
      return live
    },

    raw(text: string): void {
      write(text)
    },

    log(line: string): void {
      write(`${line}\n`)
    },

    err(line: string): void {
      writeErr(`${line}\n`)
    }
  }
}
