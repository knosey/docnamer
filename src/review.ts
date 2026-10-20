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
 * On a terminal `e` and `t` open the row's name or type for editing, and Esc
 * leaves the row as it was; on a pipe the rest of the line is the value.
 *
 * Every decision is written back to `<folder>/.docnamer-plan.json` when the
 * review ends (EOF or q). Nothing is renamed here — statuses only.
 */
import type { Config } from './config.ts'
import { buildName } from './name.ts'
import { editLine, nextStdinChunk } from './prompt.ts'
import { extOf, PLAN_FILE, writePlan, type PlanRow } from './commands.ts'
import type { Checked } from './validate.ts'
import { hasDevice, type Ui } from './ui.ts'

export type ReviewAction = 'accept' | 'edit' | 'retype' | 'skip' | 'accept-unflagged'

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
      // Re-render the name from the new type's template; the other rows' names
      // occupy the namespace so the render cannot collide with them.
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
      const planned = new Set(out.filter((_, i) => i !== index).map(r => r.new))
      row.new = await buildName(checked, config, { dir: '', ext: extOf(row.new) }, planned)
      row.status = 'accepted'
      break
    }
    case 'accept-unflagged':
      for (const r of out) {
        if (r.status === 'pending' && r.flags.length === 0) r.status = 'accepted'
      }
      break
  }
  return out
}

/** One row rendered for the person deciding on it. The flags are the reason the
 *  row needs a person at all, so they carry the warning colour. `at`/`of` are the
 *  row's place in the review, not its index in the plan: a plan index tells the
 *  person nothing about how much is left. */
function renderRow(row: PlanRow, at: number, of: number, u: Ui): string {
  const lines = [
    `${u.dim(`[${at}/${of}]`)} ${u.bold(row.old)}`,
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

/**
 * The value `e` or `t` carries, or null when none was given. A pipe sends it on
 * the line after the key; a terminal sends the key alone, so the value is typed
 * into a line that starts from what the row holds now.
 */
async function valueFor(
  action: 'edit' | 'retype',
  row: PlanRow,
  rest: string,
  terminal: boolean,
  u: Ui
): Promise<string | null> {
  const end = rest.search(/[\r\n]/)
  const typed =
    terminal && end < 0
      ? await editLine(
          u.dim(`    ${action === 'edit' ? 'new name' : 'type'}: `),
          action === 'edit' ? row.new : row.type,
          text => u.raw(text),
          rest
        )
      : end < 0
        ? rest
        : rest.slice(0, end)
  const value = typed?.trim() ?? ''
  return value === '' ? null : value
}

/** Where a review is: the rows as decided so far and the row on screen. */
type Session = {
  rows: PlanRow[]
  cursor: number
  readonly order: readonly { row: PlanRow; index: number }[]
  readonly terminal: boolean
  readonly config: Config
  readonly u: Ui
}

/** Show the row under the cursor; past the last row there is nothing to show. */
function show(s: Session): void {
  const item = s.order[s.cursor]
  if (item) s.u.log(renderRow(item.row, s.cursor + 1, s.order.length, s.u))
}

/** Decide the row on screen and move to the next one. */
async function decide(
  s: Session,
  action: ReviewAction,
  value: string | null = null
): Promise<void> {
  const item = s.order[s.cursor]
  if (!item) return
  s.rows = await applyAction(s.rows, item.index, action, value, s.config)
  s.cursor++
  show(s)
}

/** `e` or `t`: the row is decided once a usable value is given, and stays on
 *  screen, with the reason said, when none is. False when no row is on screen,
 *  so nothing after the key was taken as its value. */
async function editRow(s: Session, action: 'edit' | 'retype', rest: string): Promise<boolean> {
  const item = s.order[s.cursor]
  if (!item) return false
  const value = await valueFor(action, item.row, rest, s.terminal, s.u)
  if (value === null) {
    s.u.log(s.u.dim('    unchanged'))
  } else if (action === 'retype' && !s.config.types[value]) {
    s.u.log(
      s.u.warn(`    no type "${value}" \u2014 one of ${Object.keys(s.config.types).join(', ')}`)
    )
  } else {
    await decide(s, action, value)
  }
  return true
}

/** The keys that decide the row on screen outright. Enter accepts it: a
 *  raw-mode terminal sends CR and a piped line sends LF, and neither is a skip. */
const DECISIONS: Record<string, ReviewAction> = { '\r': 'accept', '\n': 'accept', s: 'skip' }

/** The keys that take a value before they decide the row. */
const EDITS: Record<string, 'edit' | 'retype'> = { e: 'edit', t: 'retype' }

/**
 * One key of the review, with `rest` the bytes after it in the same read.
 * 'stop' ends the review, 'line' says the key took the rest of the read as its
 * value, and 'key' says the next byte is the next key.
 */
async function onKey(s: Session, ch: string, rest: string): Promise<'stop' | 'line' | 'key'> {
  if (ch === 'q') return 'stop'
  const edit = EDITS[ch]
  if (edit !== undefined) return (await editRow(s, edit, rest)) ? 'line' : 'key'
  const decision = DECISIONS[ch]
  if (decision !== undefined) await decide(s, decision)
  // SAFE: 'accept-unflagged' sweeps every pending unflagged row and never
  // reads the index; the cursor's row is passed only because applyAction
  // takes one, and past the last row there is none, so 0 stands in.
  else if (ch === 'A') {
    const at = s.order[s.cursor]?.index ?? 0
    s.rows = await applyAction(s.rows, at, 'accept-unflagged', null, s.config)
  }
  return 'key'
}

/**
 * Review the plan file of `folder`: present every pending row, flagged first,
 * apply the keys read from stdin and write the updated plan back. Keys are
 * consumed as they arrive; `e` and `t` take a value as well. EOF ends the
 * review.
 */
export async function review(folder: string, config: Config, u: Ui): Promise<void> {
  const planPath = `${folder}/${PLAN_FILE}`
  if (!(await Bun.file(planPath).exists())) {
    throw new Error(`review: no plan file at ${planPath} — run docnamer plan first`)
  }
  const rows = JSON.parse(await Bun.file(planPath).text()) as PlanRow[]
  // Flagged rows are where a person is needed; they go first.
  const order = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === 'pending')
    .sort((a, b) => Number(b.row.flags.length > 0) - Number(a.row.flags.length > 0))

  u.log(u.head(`Reviewing ${order.length} pending row(s)`, planPath))
  u.log(
    u.dim('keys: Enter accept · s skip · e edit name · t retype · A accept all unflagged · q quit')
  )

  const stdin = process.stdin
  const raw = stdin.isTTY && typeof stdin.setRawMode === 'function'
  const s: Session = { rows, cursor: 0, order, terminal: hasDevice() || raw, config, u }
  if (raw) stdin.setRawMode(true)
  try {
    show(s)
    const decoder = new TextDecoder()
    // The same reader the picker and the prompts use: a second consumer of
    // Bun's stdin stream takes the lock the first one holds and throws.
    let ended = false
    while (!ended) {
      const chunk = await nextStdinChunk()
      if (chunk === null) break
      const text = decoder.decode(chunk)
      for (let i = 0; i < text.length; i++) {
        // charAt returns '' past the end, which the loop bound already excludes.
        const took = await onKey(s, text.charAt(i), text.slice(i + 1))
        ended = took === 'stop'
        if (took !== 'key') break
      }
    }
  } finally {
    if (raw) stdin.setRawMode(false)
  }

  await writePlan(folder, s.rows)
  const accepted = s.rows.filter(r => r.status === 'accepted').length
  const skipped = s.rows.filter(r => r.status === 'skipped').length
  const pending = s.rows.filter(r => r.status === 'pending').length
  u.log(u.ok(`review done: ${accepted} accepted, ${skipped} skipped, ${pending} pending`))
}
