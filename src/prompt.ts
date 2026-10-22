/**
 * The interactive layer: the provider picker a bare `docnamer login` opens.
 *
 * The picker itself is hand-built — a list, a cursor and four keys — because
 * the difficulty is entirely in reading the keys, which a framework would not
 * have hidden:
 *
 *  - a sequence arrives SPLIT: a lone ESC in one read and `[A` in the next must
 *    still be one Up, so the decoder holds a trailing partial sequence;
 *  - arrows arrive as SS3 (`ESC O B`) or CSI (`ESC [ B`) depending on the
 *    terminal's cursor-key mode, and matching only one silently ignores every
 *    arrow;
 *  - the mirror of that: `ESC [ A ESC [ B` may arrive as ONE read, so a chunk is
 *    a queue of keys and never a single key.
 *
 * The width ruler is NOT hand-built: `visibleWidth` and `truncateToWidth` come
 * from pi-tui, which already counts graphemes and ANSI sequences correctly.
 * Every drawn line is clipped to the terminal's width, so one line is always
 * one physical row and the redraw's line count is the terminal's row count.
 *
 * `keyDecoder`, `filter`, `nextCursor` and `pickerFrame` are pure and take bytes
 * or plain values, so the traps are asserted directly rather than through a
 * terminal — a pty gives a byte stream, not a screen.
 *
 * THIS MODULE OWNS STDIN: the picker's answer and the login flow's answer are the
 * same byte stream, and a second `getReader()` over `Bun.stdin.stream()` throws
 * on the lock the first one holds.
 */
import { Input } from '@earendil-works/pi-tui/dist/components/input.js'
import { StdinBuffer } from '@earendil-works/pi-tui/dist/stdin-buffer.js'
import { FAKE_CURSOR_END, FAKE_CURSOR_START } from '@earendil-works/pi-tui/dist/tui.js'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { deviceStream, hasDevice, terminalWidth, ui, type Style } from './ui.ts'

const ESC = String.fromCharCode(27)
const ERASE = `${ESC}[J`

/** How many rows of a long catalog are on screen at once. */
export const WINDOW = 12

export type Option = {
  readonly id: string
  readonly label: string
  readonly detail?: string
  /** What is shown after the detail. A `\u00b7` separates the essential word
   *  (`signed in`) from extra context (the store path): a terminal too narrow
   *  for the whole cell keeps only the essential part. */
  readonly status?: string
}

export type Key =
  | { readonly type: 'up' }
  | { readonly type: 'down' }
  | { readonly type: 'enter' }
  | { readonly type: 'cancel' }
  | { readonly type: 'backspace' }
  | { readonly type: 'char'; readonly char: string }

export type PickerIo = {
  readonly isTTY: boolean
  out(text: string): void
  read(): Promise<string>
}

export type Decoder = {
  (chunk: Uint8Array): Key[]
  /** Resolve a held partial sequence. A lone ESC is a cancel once nothing follows it. */
  flush(): Key[]
}

/**
 * A stateful byte decoder: one keypress can arrive in two reads, and one read can
 * carry several keypresses.
 */
export function keyDecoder(): Decoder {
  const decoder = new TextDecoder()
  let held = ''

  const decode = (chunk: Uint8Array): Key[] => {
    const text = held + decoder.decode(chunk, { stream: true })
    held = ''
    const keys: Key[] = []
    let i = 0
    while (i < text.length) {
      const ch = text.charAt(i)
      if (ch === ESC) {
        const rest = text.slice(i)
        // The sequence is incomplete: hold it rather than guess. A terminal
        // splits these often enough that guessing ignores every arrow.
        if (rest.length === 1) {
          held = rest
          break
        }
        const intro = rest.slice(0, 2)
        if (intro === `${ESC}[` || intro === `${ESC}O`) {
          if (rest.length === 2) {
            held = rest
            break
          }
          const final = rest.charAt(2)
          if (final === 'A') keys.push({ type: 'up' })
          else if (final === 'B') keys.push({ type: 'down' })
          i += 3
          continue
        }
        // ESC followed by anything that cannot introduce an arrow is a real
        // cancel; the byte after it is then read on its own.
        keys.push({ type: 'cancel' })
        i += 1
        continue
      }
      if (ch === '\r' || ch === '\n') keys.push({ type: 'enter' })
      // Raw mode means the terminal raises no SIGINT, so Ctrl-C and Ctrl-D reach
      // this decoder as bytes and must end the answer themselves.
      else if (ch === '\u0003' || ch === '\u0004') keys.push({ type: 'cancel' })
      else if (ch === '\u007f' || ch === '\b') keys.push({ type: 'backspace' })
      // Every other control byte is dropped: it is not text, and a filter
      // holding an invisible character matches nothing and reads as a hang.
      // A space is text: a file name holds them.
      else if (ch >= ' ') keys.push({ type: 'char', char: ch })
      i += 1
    }
    return keys
  }

  return Object.assign(decode, {
    flush: (): Key[] => {
      if (held === '') return []
      held = ''
      return [{ type: 'cancel' }]
    }
  })
}

export function filter(options: readonly Option[], query: string): Option[] {
  // No provider id holds a space, so a typed one would only empty the list.
  const needle = query.replace(/\s/g, '').toLowerCase()
  if (needle === '') return [...options]
  return options.filter(
    o => o.id.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle)
  )
}

export function nextCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) throw new Error(`prompt: nextCursor asked to move through ${count} option(s)`)
  return (((cursor + delta) % count) + count) % count
}

export type Frame = {
  readonly title: string
  readonly options: readonly Option[]
  readonly cursor: number
  readonly query: string
  readonly style: Style
  /** The terminal's width in cells. No line the frame returns is wider. */
  readonly cols: number
}

/**
 * The lines the picker draws, as plain strings. The cursor is clamped to what is
 * on screen, so a stale cursor can never leave the list without a pointer — a
 * frame with no marker reads as a hung program.
 */
/**
 * The status cell that fits what the other cells left: the full text, else its
 * essential word (the part before the `\u00b7`), else nothing at all — a cell
 * drawn half-price reads as a rendering bug, not as a budget.
 */
function statusCell(ok: string, status: string | undefined, budget: number): string {
  if (status === undefined) return ''
  const full = `${ok} ${status}`
  if (visibleWidth(full) <= budget) return full
  const cut = status.indexOf('\u00b7')
  const essential = (cut === -1 ? status : status.slice(0, cut)).trimEnd()
  const short = `${ok} ${essential}`
  return visibleWidth(short) <= budget ? short : ''
}

export function pickerFrame(o: Frame): string[] {
  const u = ui(o.style)
  const g = u.glyphs
  const shown = filter(o.options, o.query)
  const hint = `${g.up}/${g.down} move \u00b7 type to filter \u00b7 enter pick \u00b7 esc cancel`
  const filtered = o.query === '' ? '' : `  ${u.dim(`filter: ${o.query}`)}`
  const lines = [`? ${u.bold(o.title)}  ${u.dim(hint)}${filtered}`, '']
  // The backstop: whatever budget math below misses, no drawn line is ever
  // wider than the terminal, so one line is one physical row and the redraw's
  // line count IS the terminal's row count. truncateToWidth emits a reset
  // around the ellipsis, which is why clipping lives here and not on the
  // piped path, where zero escapes may be written.
  const ellipsis = o.style.unicode ? '\u2026' : '...'
  const clip = (line: string): string => truncateToWidth(line, o.cols, ellipsis)

  if (shown.length === 0) {
    lines.push(`  ${u.dim(`no provider matches "${o.query}"`)}`)
    return lines.map(clip)
  }

  const at = Math.min(o.cursor, shown.length - 1)
  const start = Math.min(
    Math.max(at - Math.floor(WINDOW / 2), 0),
    Math.max(0, shown.length - WINDOW)
  )
  const end = Math.min(start + WINDOW, shown.length)
  const labelW = shown.reduce((w, x) => Math.max(w, x.label.length), 0)
  const detailW = shown.reduce(
    (w, x) => Math.max(w, x.detail === undefined ? 0 : x.detail.length),
    0
  )
  // The status cell gets what the other cells leave: pointer 2, label, two
  // 2-cell gaps, detail. What does not fit whole is shortened, then dropped.
  const statusBudget = o.cols - 2 - labelW - 2 - detailW - 2

  if (start > 0) lines.push(`  ${u.dim(`${g.up} ${start} more above`)}`)
  for (let i = start; i < end; i += 1) {
    const opt = shown[i] as Option
    const detail = opt.detail === undefined ? '' : opt.detail
    const status = statusCell(g.ok, opt.status, statusBudget)
    lines.push(
      u.row(i === at ? `${g.pointer} ` : '  ', [opt.label, detail, status], [labelW, detailW, 0])
    )
  }
  if (end < shown.length) lines.push(`  ${u.dim(`${g.down} ${shown.length - end} more below`)}`)
  return lines.map(clip)
}

/**
 * stdin as bytes, read at most once at a time, with the in-flight read kept
 * rather than discarded so the idle timer below can give up on a partial escape
 * sequence without throwing away the bytes that arrive just after it.
 *
 * The reader is named structurally because Bun's stdin stream and a device file
 * stream are declared by two different `ReadableStream` types; these are the only
 * members ever touched.
 */
type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
}
let reader: ByteReader | null = null
let inflight: Promise<Uint8Array | null> | null = null
let ended = false
let lineBuffer = ''
const bytes = new TextDecoder()

function readOnce(): Promise<Uint8Array | null> {
  if (inflight === null) {
    // With a device registered, stdin is not a terminal at all: the keys
    // arrive on the device path instead.
    if (reader === null) reader = (deviceStream() ?? Bun.stdin.stream()).getReader()
    const r = reader
    inflight = r.read().then(read => {
      if (read.done === true) {
        ended = true
        return null
      }
      return read.value as Uint8Array
    })
  }
  return inflight
}

/** Release the reader that pulled from stdin.
 *
 * Bun's stdin stream keeps the process ALIVE until the reader over it is
 * cancelled — there is no end of input on a terminal to reach, so a command that
 * read a keystroke and finished would print its success line and then never give
 * the prompt back. Only for the end of a command: a later prompt would find the
 * stream closed. */
export async function releaseStdin(): Promise<void> {
  if (reader === null) return
  const held = reader
  reader = null
  inflight = null
  await held.cancel()
}

/** The next chunk of stdin as bytes, for a caller that reads its own keys. */
export async function nextStdinChunk(): Promise<Uint8Array | null> {
  const chunk = await readOnce()
  take()
  return chunk
}

/** Release the consumed chunk so the next `readOnce` really reads. */
function take(): void {
  inflight = null
}

function eof(): never {
  throw new Error('docnamer: the input ended before the question was answered')
}

/** The next line of stdin without its terminator. A prompt nobody can answer
 *  must not read as an answer of "", so the end of input throws. */
export async function stdinLine(): Promise<string> {
  for (;;) {
    const at = lineBuffer.indexOf('\n')
    if (at >= 0) {
      const line = lineBuffer.slice(0, at).replace(/\r$/, '')
      lineBuffer = lineBuffer.slice(at + 1)
      return line
    }
    if (ended) {
      const rest = lineBuffer.replace(/\r$/, '')
      if (rest === '') eof()
      lineBuffer = ''
      return rest
    }
    const chunk = await readOnce()
    if (chunk !== null) lineBuffer += bytes.decode(chunk)
    take()
  }
}

/** The keys a terminal delivers, as keys rather than as bytes. */
async function* stdinKeys(): AsyncGenerator<Key> {
  const decode = keyDecoder()
  for (;;) {
    const chunk = await readOnce()
    if (chunk === null) return
    take()
    let keys = decode(chunk)
    if (keys.length === 0) {
      // Either the start of an escape sequence or a lone ESC. Give the rest of
      // the sequence a moment to arrive; if nothing does, the ESC was the key.
      // The new read is left in flight on a timeout rather than discarded, so
      // the bytes that lost the race are the next chunk instead of lost.
      const raced = await Promise.race([
        readOnce(),
        new Promise<'idle'>(resolve => {
          setTimeout(() => resolve('idle'), 60)
        })
      ])
      if (raced === 'idle') keys = decode.flush()
      else if (raced === null) return
      else {
        take()
        keys = decode(raced)
      }
    }
    for (const key of keys) yield key
  }
}

async function pickInteractive(
  title: string,
  options: readonly Option[],
  style: Style,
  io: PickerIo
): Promise<string | null> {
  const stdin = process.stdin
  // A device terminal is already raw: the wrapper set it before launch, and
  // this process has no fd to call setRawMode on anyway.
  const raw = !hasDevice()
  if (raw && typeof stdin.setRawMode !== 'function') {
    throw new Error('prompt: this terminal cannot be put in raw mode, so no picker can be drawn')
  }
  let cursor = 0
  let query = ''
  let drawn = 0
  const cols = terminalWidth()
  const paint = (): void => {
    const frame = pickerFrame({ title, options, cursor, query, style, cols })
    io.out(`${drawn > 0 ? `${ESC}[${drawn}A` : ''}${ERASE}${frame.join('\n')}\n`)
    drawn = frame.length
  }
  // Raw mode alone starts the flow. `stdin.resume()` would instead hand the
  // stream to Bun's own consumer and LOCK it, so the reader below would throw
  // "ReadableStream is locked" on the first keystroke (verified on a real pty).
  if (raw) stdin.setRawMode(true)
  paint()
  try {
    for await (const key of stdinKeys()) {
      const shown = filter(options, query)
      if (key.type === 'cancel') return null
      if (key.type === 'enter') {
        const chosen = shown[cursor]
        return chosen === undefined ? null : chosen.id
      }
      if (key.type === 'up' && shown.length > 0) cursor = nextCursor(cursor, -1, shown.length)
      else if (key.type === 'down' && shown.length > 0) cursor = nextCursor(cursor, 1, shown.length)
      else if (key.type === 'backspace') {
        query = query.slice(0, -1)
        cursor = 0
      } else if (key.type === 'char') {
        query += key.char
        cursor = 0
      }
      paint()
    }
    return null
  } finally {
    if (raw) stdin.setRawMode(false)
    if (drawn > 0) io.out(`${ESC}[${drawn}A${ERASE}`)
  }
}

/** Whole keys from the terminal, one sequence each. */
export type Keys = {
  /** The next key, or null once the input has ended. */
  next(): Promise<string | null>
}

/**
 * The terminal's keys as pi-tui's `StdinBuffer` splits them: an arrow, Home or
 * Delete is one key however the reads cut it, and a lone Esc is a key once
 * nothing follows it. The buffer releases a held sequence on a timer, so a key
 * can arrive between reads as well as with one.
 */
export function terminalKeys(): Keys {
  const buffer = new StdinBuffer()
  const queue: string[] = []
  let wake: (() => void) | null = null
  const push = (key: string): void => {
    queue.push(key)
    wake?.()
  }
  buffer.on('data', push)
  // `Input` takes a paste whole when it comes wrapped in its markers.
  buffer.on('paste', text => push(`${ESC}[200~${text}${ESC}[201~`))
  return {
    async next(): Promise<string | null> {
      for (;;) {
        const key = queue.shift()
        if (key !== undefined) return key
        const woken = new Promise<'woken'>(resolve => {
          wake = () => resolve('woken')
        })
        // A read that loses to the timer stays in flight for the next call.
        const raced = await Promise.race([readOnce(), woken])
        wake = null
        if (raced === 'woken') continue
        take()
        if (raced === null) {
          queue.push(...buffer.flush())
          return queue.shift() ?? null
        }
        buffer.process(bytes.decode(raced, { stream: true }))
      }
    }
  }
}

/** A line rendered by `Input`, with pi-tui's cursor markers drawn the way its
 *  own renderer draws them: as a reverse-video cell. */
function withCursor(line: string): string {
  return line.replaceAll(FAKE_CURSOR_START, `${ESC}[7m`).replaceAll(FAKE_CURSOR_END, `${ESC}[27m`)
}

/** One line being edited inside a frame the caller draws. */
export type LineEdit = {
  /** Feed one key: the line once Enter ends the edit, null once Esc or Ctrl-C
   *  does, undefined while it goes on. */
  key(key: string): string | null | undefined
  /** The line as it stands, `width` cells wide, its cursor a reverse-video cell. */
  render(width: number): string
}

/**
 * One line edited in pi-tui's `Input`: ←/→, Home/End, word moves, deletes, kill
 * and yank, undo and paste. It starts from `initial` with the cursor at its end,
 * so an edit begins with what is there. The line is drawn by whoever owns the
 * screen, as one line of its frame: a line painted on its own beside a frame the
 * caller redraws is overwritten by the next redraw.
 */
export const lineEdit = (label: string, initial: string): LineEdit => {
  const input = new Input({ prompt: label })
  input.setValue(initial)
  input.handleInput(`${ESC}[F`)
  let answer: string | null | undefined
  input.onSubmit = value => {
    answer = value
  }
  input.onEscape = () => {
    answer = null
  }
  return {
    key: (key: string) => {
      input.handleInput(key)
      return answer
    },
    render: (width: number) => withCursor(input.render(width)[0] ?? '')
  }
}

async function pickNumbered(
  title: string,
  options: readonly Option[],
  style: Style,
  io: PickerIo
): Promise<string | null> {
  const u = ui(style)
  const numW = String(options.length).length
  const labelW = options.reduce((w, o) => Math.max(w, o.label.length), 0)
  const detailW = options.reduce(
    (w, o) => Math.max(w, o.detail === undefined ? 0 : o.detail.length),
    0
  )
  const lines = [`? ${title}`]
  for (let i = 0; i < options.length; i += 1) {
    const opt = options[i] as Option
    const detail = opt.detail === undefined ? '' : opt.detail
    const status = opt.status === undefined ? '' : opt.status
    lines.push(
      u.row(
        `  ${String(i + 1).padStart(numW)}) `,
        [opt.label, detail, status],
        [labelW, detailW, 0]
      )
    )
  }
  lines.push('  choose a number, a provider name, or q to cancel')
  io.out(`${lines.join('\n')}\n`)

  const answer = (await io.read()).trim()
  if (answer === 'q' || answer === 'quit' || answer === 'esc') return null
  if (/^\d+$/.test(answer)) {
    const at = Number(answer) - 1
    if (at >= 0 && at < options.length) return (options[at] as Option).id
    throw new Error(`unknown choice: ${answer}`)
  }
  const lower = answer.toLowerCase()
  for (const opt of options) if (opt.id.toLowerCase() === lower) return opt.id
  throw new Error(`unknown choice: ${answer}`)
}

/**
 * Ask for one of `options` and return the chosen id, or null when the person
 * cancelled. On a terminal this draws a picker; on a pipe it prints the same
 * list numbered and reads a line, because a picker needs a screen to redraw.
 */
export async function pick(
  title: string,
  options: readonly Option[],
  style: Style,
  io?: PickerIo
): Promise<string | null> {
  if (options.length === 0) throw new Error(`prompt: nothing to pick for "${title}"`)
  const stream: PickerIo =
    io === undefined
      ? {
          // A device IS the terminal the wrapper prepared; stdin is a pipe.
          isTTY: hasDevice() || process.stdin.isTTY === true,
          out: (text: string): void => {
            ui(style).raw(text)
          },
          read: stdinLine
        }
      : io
  return stream.isTTY
    ? pickInteractive(title, options, style, stream)
    : pickNumbered(title, options, style, stream)
}
