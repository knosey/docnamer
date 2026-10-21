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
import { truncateToWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { editLine, nextStdinChunk, terminalKeys, type Keys } from './prompt.ts'
import { extOf, PLAN_FILE, readPlan, writePlan, type PlanRow } from './commands.ts'
import type { Checked } from './validate.ts'
import { hasDevice, terminalWidth, type Ui } from './ui.ts'

type ReviewAction = 'accept' | 'edit' | 'retype' | 'skip' | 'accept-unflagged'

/** Retype one row: the row takes the new type and its name is re-rendered
 *  from that type's template; the other rows' names occupy the namespace so the
 *  render cannot collide with a name it is not allowed to take. */
async function retypeRow(
  row: PlanRow,
  value: string | null,
  config: Config,
  planned: Set<string>
): Promise<void> {
  if (!value) throw new Error('applyAction: retype needs the type as its value')
  if (!config.types[value]) throw new Error(`applyAction: config has no type "${value}"`)
  row.type = value
  // SAFE: the plan format writes "no evidence" as an empty string, so a row
  // read back from it legitimately has none; only `value` reaches the template.
  const checked: Checked = {
    type: value,
    type_confidence: 1,
    fields: Object.fromEntries(
      Object.entries(row.fields).map(([k, v]) => [k, { value: v, evidence: row.evidence[k] ?? '' }])
    ),
    summary: row.summary,
    flags: row.flags
  }
  row.new = await buildName(checked, config, { dir: '', ext: extOf(row.new) }, planned)
  row.status = 'accepted'
}

/** Accept every pending flag-free row; a flagged row stays for the person. */
function acceptUnflagged(out: PlanRow[]): void {
  for (const r of out) {
    if (r.status === 'pending' && r.flags.length === 0) r.status = 'accepted'
  }
}

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
      const planned = new Set(out.filter((_, i) => i !== index).map(r => r.new))
      await retypeRow(row, value, config, planned)
      break
    }
    case 'accept-unflagged':
      acceptUnflagged(out)
      break
  }
  return out
}

/** One row rendered for the person deciding on it. The flags are the reason the
 *  row needs a person at all, so they carry the warning colour. `at`/`of` are the
 *  row's place in the review, not its index in the plan: a plan index tells the
 *  person nothing about how much is left. A row already decided says so: moving
 *  back to it is how a decision is changed. */
function renderRow(row: PlanRow, at: number, of: number, u: Ui): string {
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
  return lines.join('\n')
}

/** Where a review is: the rows as decided so far and the row on screen. */
type Session = {
  rows: PlanRow[]
  cursor: number
  /** Plan indexes, in the order the rows are reviewed. */
  readonly order: readonly number[]
  readonly config: Config
  readonly u: Ui
  /** The terminal's keys, or null on a pipe, where a value follows its key on
   *  the same line. */
  readonly keys: Keys | null
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
function commandOf(key: string): Command | undefined {
  if (matchesKey(key, 'up')) return 'prev'
  if (matchesKey(key, 'down')) return 'next'
  if (matchesKey(key, 'escape') || matchesKey(key, 'ctrl+c')) return 'quit'
  return CHAR_COMMANDS[key]
}

/** The row under the cursor and its plan index; past the last row, none. */
function current(s: Session): { row: PlanRow; index: number } | null {
  const index = s.order[s.cursor]
  const row = index === undefined ? undefined : s.rows[index]
  return index === undefined || row === undefined ? null : { row, index }
}

/** The controls, restated above each card so they stay on screen however far
 *  the review has scrolled. */
function controls(u: Ui): string {
  return u.dim('keys: Enter accept · s skip · e edit · t retype · A accept unflagged · q quit')
}

/** Show the row under the cursor and the one after it as stacked padded cards,
 *  or say every row has been seen. */
function show(s: Session): void {
  const at = current(s)
  if (!at) {
    s.u.log(s.u.dim(`every row seen — q saves and quits${s.keys ? ', ↑ goes back' : ''}`))
    return
  }
  s.u.log('')
  s.u.log(controls(s.u))
  s.u.log(renderRow(at.row, s.cursor + 1, s.order.length, s.u))
  const ahead = s.order[s.cursor + 1]
  const next = ahead === undefined ? undefined : s.rows[ahead]
  if (next !== undefined) {
    s.u.log('')
    s.u.log(renderRow(next, s.cursor + 2, s.order.length, s.u))
  }
}

/** Move the cursor without deciding anything. */
function move(s: Session, delta: number): void {
  const to = s.cursor + delta
  if (to < 0 || to >= s.order.length) return
  s.cursor = to
  show(s)
}

/** Decide the row on screen and move to the next one. */
async function decide(
  s: Session,
  action: ReviewAction,
  value: string | null = null
): Promise<void> {
  const at = current(s)
  if (!at) return
  s.rows = await applyAction(s.rows, at.index, action, value, s.config)
  s.cursor++
  show(s)
}

/**
 * The value `e` or `t` carries, or null when none was given. A pipe sends it on
 * the line after the key; on a terminal it is edited in a line that starts from
 * what the row holds now.
 */
async function valueFor(
  s: Session,
  action: 'edit' | 'retype',
  row: PlanRow,
  rest: string
): Promise<string | null> {
  const end = rest.search(/[\r\n]/)
  const typed =
    s.keys === null
      ? end < 0
        ? rest
        : rest.slice(0, end)
      : await editLine(
          s.u.dim(`    ${action === 'edit' ? 'new name' : 'type'}: `),
          // A row already decided is being revisited: the person re-types its
          // value, so the line opens empty and what is typed replaces, not
          // appends. A pending row opens on what it holds now.
          row.status === 'pending' ? (action === 'edit' ? row.new : row.type) : '',
          text => s.u.raw(text),
          s.keys
        )
  const value = typed?.trim() ?? ''
  return value === '' ? null : value
}

/** `e` or `t`: the row is decided once a usable value is given, and stays on
 *  screen, with the reason said, when none is. False when no row is on screen,
 *  so nothing after the key was taken as its value. */
async function editRow(s: Session, action: 'edit' | 'retype', rest: string): Promise<boolean> {
  const at = current(s)
  if (!at) return false
  const value = await valueFor(s, action, at.row, rest)
  if (value === null) {
    s.u.log(s.u.dim('    unchanged'))
  } else if (action === 'retype' && !s.config.types[value]) {
    s.u.log(s.u.warn(`    no type "${value}" — one of ${Object.keys(s.config.types).join(', ')}`))
  } else {
    await decide(s, action, value)
  }
  return true
}

/** Carry out one command other than quit; true when it took the rest of a
 *  piped line as its value. */
async function run(s: Session, command: Exclude<Command, 'quit'>, rest: string): Promise<boolean> {
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

/** Review by key on a terminal, until q, Esc or Ctrl-C, or the input ends. */
async function readTerminal(s: Session, keys: Keys): Promise<void> {
  for (;;) {
    const key = await keys.next()
    if (key === null) return
    const command = commandOf(key)
    if (command === 'quit') return
    if (command !== undefined) await run(s, command, '')
  }
}

/** Review from a pipe, one character a command, until q or the end of input. */
async function readPipe(s: Session): Promise<void> {
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

  // The plan path can run past the terminal; a line wider than the screen wraps
  // and breaks the card layout, so the header is clipped to the width.
  const width = terminalWidth()
  u.log(
    u
      .head(`Reviewing ${order.length} pending row(s)`, planPath)
      .split('\n')
      .map(line => truncateToWidth(line, width))
      .join('\n')
  )

  const stdin = process.stdin
  const raw = stdin.isTTY && typeof stdin.setRawMode === 'function'
  // A device terminal is already raw: the wrapper set it before launch.
  const keys = hasDevice() || raw ? terminalKeys() : null
  const s: Session = { rows, cursor: 0, order, config, u, keys }
  if (raw) stdin.setRawMode(true)
  try {
    show(s)
    await (keys === null ? readPipe(s) : readTerminal(s, keys))
  } finally {
    if (raw) stdin.setRawMode(false)
  }

  await writePlan(folder, s.rows)
  const accepted = s.rows.filter(r => r.status === 'accepted').length
  const skipped = s.rows.filter(r => r.status === 'skipped').length
  const pending = s.rows.filter(r => r.status === 'pending').length
  u.log(u.ok(`review done: ${accepted} accepted, ${skipped} skipped, ${pending} pending`))
}
