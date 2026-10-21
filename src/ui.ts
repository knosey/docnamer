/**
 * The one owner of every byte docnamer writes: a command asks for a line and
 * this decides what it looks like, so the ASCII fallback and the
 * no-colour-on-a-pipe rule hold everywhere at once.
 *
 * Colour off must emit ZERO escape sequences: tests/frame.ts rasterises piped
 * stdout into the frame the visual review reads, so a stray ANSI code corrupts
 * the evidence rather than the appearance.
 */
import { visibleWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { deviceReader, deviceWriter } from './device.ts'

export type Style = {
  readonly colour: boolean
  readonly unicode: boolean
  readonly tty: boolean
}

const ESC = String.fromCharCode(27)

/** LC_ALL, then LC_CTYPE, then LANG. An unset locale means UTF-8, not ASCII:
 *  that is the macOS terminal's own encoding. */
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
  // NO_COLOR selects the ASCII glyph set too: a redirected log never carries
  // a block glyph a file cannot mean.
  const ascii = 'NO_COLOR' in env
  return {
    colour: tty && !ascii && env.TERM !== 'dumb',
    unicode: !ascii && env.TERM !== 'dumb' && utf8(env),
    tty
  }
}

type Glyphs = {
  readonly full: string
  readonly empty: string
  readonly ok: string
  readonly warn: string
  readonly pointer: string
  readonly rule: string
  readonly dash: string
  readonly dot: string
  readonly up: string
  readonly down: string
  readonly frames: readonly string[]
}

const UNICODE: Glyphs = {
  full: '\u25b0',
  empty: '\u25b1',
  ok: '\u2713',
  warn: '!',
  pointer: '\u276f',
  rule: '\u2500',
  dash: '\u2014',
  dot: '\u00b7',
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
  full: '#',
  empty: '-',
  ok: '+',
  warn: '!',
  pointer: '>',
  rule: '-',
  dash: '-',
  dot: '*',
  up: '^',
  down: 'v',
  frames: ['|', '/', '-', '\\']
}

const INDENT = '  '
const GAP = '  '
const ERASE = `${ESC}[K`

/** The terminal the wrapper handed over. A LaunchServices-launched binary has
 *  no fd for its tty, so the path is the only way in and out: `cli.ts`
 *  registers it at startup, every byte below lands on it, and `prompt.ts` reads
 *  its keys from the same path. With no device nothing here changes. */
type Device = {
  readonly writer: { write(chunk: string): unknown; end(): unknown }
  readonly stream: ReadableStream<Uint8Array>
  readonly cols: number | null
}

let active: Device | null = null

/** Register the device path as this process's terminal, with the width the
 *  wrapper measured: the launched process's own stdout is not a terminal, so
 *  it cannot answer the question itself. */
export function setDevice(path: string, cols: number | null): void {
  active = { writer: deviceWriter(path), stream: deviceReader(path), cols }
}

/** The width the drawing code must fit, in cells. */
export function terminalWidth(): number {
  if (active !== null && active.cols !== null) return active.cols
  const cols = process.stdout.columns
  // A pipe answers undefined; 80 is the width every terminal can be assumed to have.
  return typeof cols === 'number' && cols > 0 ? cols : 80
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

/** The other half of the chokepoint, so a command never reaches for
 *  console.error. A device has one stream: a failure lands where success did. */
function writeErr(text: string): void {
  if (active !== null) active.writer.write(text)
  else process.stderr.write(text)
}

function pad(text: string, width: number): string {
  // Cells, not code units: a styled cell carries escape sequences, and padding
  // to its string length would push every later column right by the escapes.
  const w = visibleWidth(text)
  return w >= width ? text : text + ' '.repeat(width - w)
}

/** The one bar a command draws, unicode blocks or ASCII by the style's glyph
 *  set: ten cells, a space, then the rounded percentage. */
export function progressBar(done: number, total: number, style: Style): string {
  const glyphs = style.unicode ? UNICODE : ASCII
  // One ratio, floored (0 of 0 is 0%): the blocks are the whole tens of the
  // percentage, so the two can never disagree and the bar is full only at 100%.
  const percent = total === 0 ? 0 : Math.floor((done / total) * 100)
  const filled = Math.floor(percent / 10)
  return `${glyphs.full.repeat(filled)}${glyphs.empty.repeat(10 - filled)} ${percent}%`
}

export type Row = readonly string[]
export type Spinner = {
  update(text: string): void
  /** `text` is the result line to leave behind. A command that threw has none,
   *  and the frame it drew still has to come off the line. */
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
  /** For a frame that positions the cursor itself; still routed through here. */
  raw(text: string): void
  log(line: string): void
  err(line: string): void
}

/** The frame sitting on the terminal's line, if one is. There is one terminal
 *  and one line, so this is the module's and not a `Ui`'s: `cli.ts` builds a
 *  second `Ui` to report a failure with, and that instance has to take the frame
 *  off, or a command that threw leaves it for the error to land on. */
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

  /** The only place a row is assembled. The margin goes out verbatim and FIRST,
   *  before any styling, so the plan table's `!` cannot be hidden by colour from
   *  the reader or from a grep. `widths` aligns a column down the page. */
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
