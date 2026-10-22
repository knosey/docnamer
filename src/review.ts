/**
 * Stage 5 review: a person walks the plan rows before apply, and every row ends
 * up accepted, skipped or left pending. `docnamer review <folder>` prints each
 * row's old name, proposed new name, type, flags, evidence and summary, and takes
 * one key per decision:
 *
 *   Enter — accept this row
 *   s — skip this row
 *   e — edit the new name, then accept
 *   t — re-type the row, re-render the name, then accept
 *   A — accept every flag-free row; flagged rows stay pending
 *   q — stop; the plan file keeps whatever was decided so far
 *
 * On a terminal ↑/↓ move between rows without deciding them, `e` and `t` open
 * the row's name or type for editing (Esc leaves the row as it was), and Esc or
 * Ctrl-C quit as q does; on a pipe the rest of the line is the value.
 *
 * Every decision is written back to `<folder>/.docnamer-plan.json` when the
 * review ends (EOF or q). Nothing is renamed here — statuses only.
 */
import type { Config } from './config.ts'
import { buildName } from './name.ts'
import { matchesKey } from '@earendil-works/pi-tui/dist/keys.js'
import { visibleWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { lineEdit, nextStdinChunk, terminalKeys, type Keys, type LineEdit } from './prompt.ts'
import { extOf, PLAN_FILE, readPlan, writePlan, type PlanRow } from './commands.ts'
import type { Checked } from './validate.ts'
import { ESC, hasDevice, progressBar, terminalHeight, terminalWidth, type Ui } from './ui.ts'

type ReviewAction = 'accept' | 'edit' | 'retype' | 'skip' | 'accept-unflagged'

/**
 * Apply one review decision to the rows and return the updated array. Pure apart
 * from retype's name render: the plan file is the caller's to persist.
 */
export async function applyAction(
  rows: PlanRow[],
  index: number,
  action: ReviewAction,
  value: string | null,
  config: Config
): Promise<PlanRow[]> {
  const out = rows.map(r => ({ ...r }))
  const row = out[index]
  if (!row) throw new Error(`applyAction: no row at index ${index} (${rows.length} rows)`)

  switch (action) {
    case 'accept':
      row.status = 'accepted'
      break
    case 'skip':
      row.status = 'skipped'
      break
    case 'edit':
      if (!value) throw new Error('applyAction: edit needs the new name as its value')
      row.new = value
      row.status = 'accepted'
      break
    case 'retype': {
      if (!value) throw new Error('applyAction: retype needs the type as its value')
      if (!config.types[value]) throw new Error(`applyAction: config has no type "${value}"`)
      row.type = value
      // SAFE: the plan format writes "no evidence" as an empty string, so a row
      // read back from it legitimately has none; only `value` reaches the template.
      const checked: Checked = {
        type: value,
        type_confidence: 1,
        fields: Object.fromEntries(
          Object.entries(row.fields).map(([k, v]) => [
            k,
            { value: v, evidence: row.evidence[k] ?? '' }
          ])
        ),
        summary: row.summary,
        flags: row.flags
      }
      // The other rows' names occupy the namespace, so the re-render cannot
      // collide with a name it is not allowed to take.
      const planned = new Set(out.filter((_, i) => i !== index).map(r => r.new))
      row.new = await buildName(checked, config, { dir: '', ext: extOf(row.new) }, planned)
      row.status = 'accepted'
      break
    }
    case 'accept-unflagged':
      // A flagged row stays for the person.
      for (const r of out) {
        if (r.status === 'pending' && r.flags.length === 0) r.status = 'accepted'
      }
      break
  }
  return out
}

/** How far a card's rows sit in from its title line. */
const CARD_INDENT = '  '

/** One row's card for the person deciding on it, as lines. The flags are the
 *  reason the row needs a person at all, so they carry the warning colour.
 *  `at`/`of` are the row's place in the review, not its index in the plan: a
 *  plan index tells the person nothing about how much is left. A row already
 *  decided says so: moving back to it is how a decision is changed. */
const card = (row: PlanRow, at: number, of: number, u: Ui): string[] => {
  const decided = row.status === 'pending' ? '' : ` ${u.dim(`(${row.status})`)}`
  const lines = [
    `${u.dim(`[${at}/${of}]`)} ${u.bold(row.old)}${decided}`,
    u.row('    ', [u.dim('new:'), row.new]),
    u.row('    ', [
      u.dim('type:'),
      row.type,
      row.flags.length > 0 ? u.warn(row.flags.join(', ')) : ''
    ]),
    u.row('    ', [u.dim('summary:'), row.summary])
  ]
  // Evidence is quoted from the document and can span its lines; one field is
  // one line here, or the next field starts in the wrong column.
  for (const [k, v] of Object.entries(row.evidence)) {
    if (v) lines.push(u.row('    ', [u.dim(`evidence ${k}:`), v.replace(/\s+/g, ' ')]))
  }
  return lines
}

/** The keys the review takes, as the header lists them. */
const KEY_HINTS = (u: Ui): string[] => [
  `${u.glyphs.up}/${u.glyphs.down} move`,
  'Enter accept',
  's skip',
  'e edit',
  't retype',
  'A accept unflagged',
  'q quit'
]

/** `items` packed into as few lines as fit `width`, the first after `lead` and
 *  the rest indented under it: the keys must all stay on screen, so they wrap
 *  between hints rather than being cut. */
const packed = (lead: string, items: readonly string[], sep: string, width: number): string[] => {
  const indent = ' '.repeat(visibleWidth(lead))
  const lines: string[] = []
  let line = lead
  for (const item of items) {
    const joined = line === lead || line === indent ? `${line}${item}` : `${line}${sep}${item}`
    if (visibleWidth(joined) <= width || line === lead || line === indent) line = joined
    else {
      lines.push(line)
      line = `${indent}${item}`
    }
  }
  lines.push(line)
  return lines
}

/** What a review frame shows: the rows as decided, where the cursor is, and
 *  the line being edited and the last note, when there are. */
export type ReviewView = {
  readonly rows: readonly PlanRow[]
  readonly order: readonly number[]
  readonly cursor: number
  readonly planPath: string
  /** The edit line, drawn in place of the row it edits. */
  readonly edit: { readonly field: 'new' | 'type'; readonly render: LineEdit['render'] } | null
  readonly note: string | null
}

/**
 * The review screen as one frame: at most `height` lines, none wider than
 * `width` — pi-tui's component contract, which its renderer enforces by
 * throwing. The header comes first in every frame — the title with the
 * position, the keys, the last note — so it cannot scroll away: the frame is
 * redrawn in place and never runs past the screen. Below it, the cards from
 * the one under the cursor down, as many as fit, padded apart by a blank line.
 */
export const reviewFrame = (v: ReviewView, width: number, height: number, u: Ui): string[] => {
  const header = frameHeader(v, width, u)
  // Past the last card there are no cards to build, only the way out.
  const body =
    v.cursor >= v.order.length
      ? frameDone(v.order.length, u)
      : frameCards(v, width, u, height - header.length)
  return [...header, ...body].slice(0, height).map(l => u.clip(l, width))
}

/** The locked header: the title with the position, its rule, the keys, the
 *  last note, and a blank line to pad it from the cards. */
const frameHeader = (v: ReviewView, width: number, u: Ui): string[] => {
  const of = v.order.length
  const where =
    v.cursor < of ? `Reviewing document ${v.cursor + 1} of ${of}` : `Reviewed all ${of} documents`
  const title = `  ${u.bold(where)} ${u.dim(u.glyphs.dash)} ${u.dim(v.planPath)}`
  const rule = `  ${u.dim(u.glyphs.rule.repeat(Math.max(0, Math.min(visibleWidth(where), width - 4))))}`
  const keys = packed('  keys: ', KEY_HINTS(u), ` ${u.glyphs.dot} `, width).map(l => u.dim(l))
  const note = v.note === null ? [] : [`  ${v.note}`]
  return [title, rule, ...keys, ...note, '']
}

/** The way out once every document has a decision, in place of the cards. */
const frameDone = (of: number, u: Ui): string[] => [
  u.ok(`${progressBar(of, of, u.style)} every document has a decision`),
  u.dim(`  q saves and quits ${u.glyphs.dot} ${u.glyphs.up} goes back`)
]

/** The cards from the one under the cursor to the end, padded apart, the
 *  current one pointed at and carrying the edit line when there is one.
 *  `budget` is how many lines the screen has left: a card past it is never
 *  drawn, so it is never built. */
const frameCards = (v: ReviewView, width: number, u: Ui, budget: number): string[] => {
  const of = v.order.length
  const lines: string[] = []
  for (let at = v.cursor; at < of && lines.length < budget; at++) {
    const row = v.rows[v.order[at] as number]
    if (row === undefined) break
    if (at > v.cursor) lines.push('')
    const body = card(row, at + 1, of, u)
    body[0] = `${at === v.cursor ? `${u.glyphs.pointer} ` : '  '}${body[0] as string}`
    // A card's rows sit two cells in; the edit line is drawn that much narrower
    // so it ends at the edge instead of being cut there.
    if (at === v.cursor && v.edit !== null) {
      body[v.edit.field === 'new' ? 1 : 2] = v.edit.render(width - CARD_INDENT.length)
    }
    lines.push(...body.map((l, i) => (i === 0 ? l : `${CARD_INDENT}${l}`)))
  }
  return lines
}

/** Where a review is: the rows as decided so far and the row on screen. */
type Session = {
  rows: PlanRow[]
  cursor: number
  /** Plan indexes, in the order the rows are reviewed. */
  readonly order: readonly number[]
  readonly config: Config
  readonly u: Ui
  readonly planPath: string
  /** The terminal's keys, or null on a pipe, where a value follows its key on
   *  the same line and every card is logged rather than drawn. */
  readonly keys: Keys | null
  /** The edit in progress on the screen, and what it edits. */
  editing: { action: 'edit' | 'retype'; line: LineEdit } | null
  /** What the screen says about the last thing that happened. */
  note: string | null
  /** How many lines the frame on screen takes. */
  drawn: number
}

type Command = ReviewAction | 'prev' | 'next' | 'quit'

/** The commands a single character names, on a terminal and on a pipe alike.
 *  Enter accepts: a raw-mode terminal sends CR and a piped line sends LF. */
const CHAR_COMMANDS: Record<string, Command> = {
  '\r': 'accept',
  '\n': 'accept',
  s: 'skip',
  e: 'edit',
  t: 'retype',
  A: 'accept-unflagged',
  q: 'quit'
}

/** A terminal key as the command it names. A key is a whole sequence, so ↑
 *  (`ESC [ A`) is never the `A` its last byte spells. Raw mode raises no
 *  SIGINT, so Ctrl-C quits here, as Esc does. */
const commandOf = (key: string): Command | undefined => {
  if (matchesKey(key, 'up')) return 'prev'
  if (matchesKey(key, 'down')) return 'next'
  if (matchesKey(key, 'escape') || matchesKey(key, 'ctrl+c')) return 'quit'
  return CHAR_COMMANDS[key]
}

/** The row under the cursor and its plan index; past the last row, none. */
const current = (s: Session): { row: PlanRow; index: number } | null => {
  const index = s.order[s.cursor]
  const row = index === undefined ? undefined : s.rows[index]
  return index === undefined || row === undefined ? null : { row, index }
}

/** Log review lines clipped to the terminal's width — a line wider than the
 *  screen wraps and breaks the card layout. The one width rule, on every line. */
const say = (u: Ui, text: string): void => {
  const width = terminalWidth()
  for (const line of text.split('\n')) u.log(u.clip(line, width))
}

/** On a pipe, log the row under the cursor and the one after it as stacked
 *  padded cards, or say every row has been seen. A screen draws its frame
 *  after every key instead. */
const show = (s: Session): void => {
  if (s.keys !== null) return
  const at = current(s)
  if (!at) {
    say(s.u, s.u.dim(`every row seen ${s.u.glyphs.dash} q saves and quits`))
    return
  }
  s.u.log('')
  // The terminal's key list, minus its move hint: a pipe has no cursor to move.
  say(s.u, s.u.dim(`keys: ${KEY_HINTS(s.u).slice(1).join(` ${s.u.glyphs.dot} `)}`))
  say(s.u, card(at.row, s.cursor + 1, s.order.length, s.u).join('\n'))
  const ahead = s.order[s.cursor + 1]
  const next = ahead === undefined ? undefined : s.rows[ahead]
  if (next !== undefined) {
    s.u.log('')
    say(s.u, card(next, s.cursor + 2, s.order.length, s.u).join('\n'))
  }
}

/** Tell the person what just happened: a log line on a pipe, the frame's note
 *  line on a screen. */
const note = (s: Session, text: string): void => {
  if (s.keys === null) s.u.log(`    ${text}`)
  else s.note = text
}

/** Draw the frame over the one on screen: up to its first line, erase to the
 *  end, then the new lines, inside a synchronized update so the terminal shows
 *  the whole frame or the old one, never half of each. One line is left for
 *  the cursor, or the last newline would scroll the frame's first line away. */
const draw = (s: Session): void => {
  const lines = reviewFrame(
    {
      rows: s.rows,
      order: s.order,
      cursor: s.cursor,
      planPath: s.planPath,
      edit:
        s.editing === null
          ? null
          : { field: s.editing.action === 'edit' ? 'new' : 'type', render: s.editing.line.render },
      note: s.note
    },
    terminalWidth(),
    terminalHeight() - 1,
    s.u
  )
  const up = s.drawn > 0 ? `${ESC}[${s.drawn}A` : ''
  s.u.raw(`${ESC}[?2026h${up}\r${ESC}[J${lines.join('\n')}\n${ESC}[?2026l`)
  s.drawn = lines.length
}

/** Take the frame off the screen, so the summary the review ends with is
 *  what stays behind in the terminal. */
const erase = (s: Session): void => {
  if (s.drawn > 0) s.u.raw(`${ESC}[${s.drawn}A\r${ESC}[J`)
  s.drawn = 0
}

/** Move the cursor without deciding anything. */
const move = (s: Session, delta: number): void => {
  const to = s.cursor + delta
  if (to < 0 || to >= s.order.length) return
  s.cursor = to
  s.note = null
  show(s)
}

/** Decide the row on screen and move to the next one. */
const decide = async (
  s: Session,
  action: ReviewAction,
  value: string | null = null
): Promise<void> => {
  const at = current(s)
  if (!at) return
  s.rows = await applyAction(s.rows, at.index, action, value, s.config)
  s.cursor++
  s.note = null
  show(s)
}

/** Decide the row with the value an edit produced, or say why it stays as it
 *  was: nothing was given, or the type is not one the config has. */
const settle = async (
  s: Session,
  action: 'edit' | 'retype',
  typed: string | null
): Promise<void> => {
  const value = typed?.trim() ?? ''
  if (value === '') note(s, s.u.dim('unchanged'))
  else if (action === 'retype' && !s.config.types[value]) {
    note(
      s,
      s.u
        .warn(
          `no type "${value}" ${s.u.glyphs.dash} one of ${Object.keys(s.config.types).join(', ')}`
        )
        .trimStart()
    )
  } else await decide(s, action, value)
}

/** `e` or `t`: on a screen, open the row's name or type for editing in the
 *  frame; on a pipe, settle it with the rest of the line. False when no row is
 *  on screen, so nothing after the key was taken as its value. */
const editRow = async (s: Session, action: 'edit' | 'retype', rest: string): Promise<boolean> => {
  const at = current(s)
  if (!at) return false
  if (s.keys === null) {
    // On a pipe the key's value is the rest of its line.
    await settle(s, action, rest.split(/[\r\n]/, 1)[0])
    return true
  }
  // The line opens on what the row holds now, decided or not: an empty line
  // hides the name being changed, so the person cannot see what they replace.
  // Ctrl-U clears it to type a new one.
  const initial = action === 'edit' ? at.row.new : at.row.type
  const label = s.u.dim(`    ${action === 'edit' ? 'new name' : 'type'}: `)
  s.editing = { action, line: lineEdit(label, initial) }
  // The header says the screen is editing and how to leave it: the edit line
  // looks like the row it replaces, bar a cursor a glance can miss.
  const dot = s.u.glyphs.dot
  const what = action === 'edit' ? 'the new name' : 'the type'
  s.note = s.u.bold(
    `Editing ${what}: Enter saves ${dot} Esc keeps it as it was ${dot} Ctrl-U clears the line`
  )
  return true
}

/** Carry out one command other than quit; true when it took the rest of a
 *  piped line as its value. */
const run = async (
  s: Session,
  command: Exclude<Command, 'quit'>,
  rest: string
): Promise<boolean> => {
  switch (command) {
    case 'prev':
      move(s, -1)
      return false
    case 'next':
      move(s, 1)
      return false
    case 'edit':
    case 'retype':
      return editRow(s, command, rest)
    case 'accept-unflagged':
      // SAFE: 'accept-unflagged' sweeps every pending unflagged row and never
      // reads the index; 0 stands in because applyAction takes one.
      s.rows = await applyAction(s.rows, 0, command, null, s.config)
      return false
    default:
      await decide(s, command)
      return false
  }
}

/** One key while an edit is open: the edit line takes it, and Enter or Esc
 *  closes the edit and settles the row. */
const editKey = async (s: Session, key: string): Promise<void> => {
  const editing = s.editing
  if (editing === null) return
  const answer = editing.line.key(key)
  if (answer === undefined) return
  s.editing = null
  await settle(s, editing.action, answer)
}

/** Review by key on a terminal, until q, Esc or Ctrl-C, or the input ends.
 *  The frame is redrawn after every key. */
const readTerminal = async (s: Session, keys: Keys): Promise<void> => {
  draw(s)
  for (;;) {
    const key = await keys.next()
    if (key === null) return
    if (s.editing !== null) {
      await editKey(s, key)
      draw(s)
      continue
    }
    const command = commandOf(key)
    if (command === 'quit') return
    // A key naming no command changes nothing; the frame on screen stays.
    if (command === undefined) continue
    const at = s.cursor
    await run(s, command, '')
    if ((command !== 'prev' && command !== 'next') || s.cursor !== at) draw(s)
  }
}

/** Review from a pipe, one character a command, until q or the end of input. */
const readPipe = async (s: Session): Promise<void> => {
  const decoder = new TextDecoder()
  // The same reader the picker and the prompts use: a second consumer of
  // Bun's stdin stream takes the lock the first one holds and throws.
  for (;;) {
    const chunk = await nextStdinChunk()
    if (chunk === null) return
    const text = decoder.decode(chunk)
    for (let i = 0; i < text.length; i++) {
      // charAt returns '' past the end, which the loop bound already excludes.
      const command = CHAR_COMMANDS[text.charAt(i)]
      if (command === 'quit') return
      if (command !== undefined && (await run(s, command, text.slice(i + 1)))) break
    }
  }
}

/**
 * Review the plan file of `folder`: present every pending row, flagged first,
 * apply the keys read from the terminal or a pipe and write the updated plan
 * back. Quitting or the end of input ends the review, and either way every
 * decision made is kept.
 */
export async function review(folder: string, config: Config, u: Ui): Promise<void> {
  const planPath = `${folder}/${PLAN_FILE}`
  const rows = await readPlan(folder, 'review')
  // Flagged rows are where a person is needed; they go first.
  const order = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === 'pending')
    .sort((a, b) => Number(b.row.flags.length > 0) - Number(a.row.flags.length > 0))
    .map(({ index }) => index)

  const stdin = process.stdin
  const raw = stdin.isTTY && typeof stdin.setRawMode === 'function'
  // A device terminal is already raw: the wrapper set it before launch.
  const keys = hasDevice() || raw ? terminalKeys() : null
  const s: Session = {
    rows,
    cursor: 0,
    order,
    config,
    u,
    planPath,
    keys,
    editing: null,
    note: null,
    drawn: 0
  }
  if (keys === null) say(u, u.head(`Reviewing ${order.length} pending row(s)`, planPath))
  if (raw) stdin.setRawMode(true)
  // The frame draws its own cursor for the edit line; the terminal's would
  // blink below the frame.
  if (keys !== null) u.raw(`${ESC}[?25l`)
  try {
    show(s)
    await (keys === null ? readPipe(s) : readTerminal(s, keys))
  } finally {
    if (keys !== null) {
      erase(s)
      u.raw(`${ESC}[?25h`)
    }
    if (raw) stdin.setRawMode(false)
  }

  await writePlan(folder, s.rows)
  const accepted = s.rows.filter(r => r.status === 'accepted').length
  const skipped = s.rows.filter(r => r.status === 'skipped').length
  const pending = s.rows.filter(r => r.status === 'pending').length
  // The completion line draws the final bar in the same format plan, apply and
  // undo draw theirs: a review carried to the end reads as the full bar, 100%.
  const done = accepted + skipped
  u.log(
    u.ok(
      `${progressBar(done, s.rows.length, u.style)} review done: ${accepted} accepted, ${skipped} skipped, ${pending} pending`
    )
  )
}
