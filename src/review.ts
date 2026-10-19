/**
 * Stage 5 review (R4, I3): a person walks the plan rows before apply, and
 * every row ends up accepted, skipped or left pending. `docnamer review
 * <folder>` prints each row's old name, proposed new name, type, flags,
 * evidence and summary, and takes one key per decision:
 *
 *   Enter — accept this row
 *   s — skip this row
 *   e — edit the new name (rest of the line is the name), then accept
 *   t — re-type the row (rest of the line is the type), re-render the name,
 *       then accept
 *   A — accept every flag-free row; flagged rows stay pending
 *   q — stop; the plan file keeps whatever was decided so far
 *
 * Every decision is written back to `<folder>/.docnamer-plan.json` when the
 * review ends (EOF or q). Nothing is renamed here — statuses only (R4).
 */
import type { Config } from './config.ts'
import { buildName } from './name.ts'
import { nextStdinChunk } from './prompt.ts'
import { extOf, PLAN_FILE, writePlan, type PlanRow } from './commands.ts'
import type { Checked } from './validate.ts'
import type { Ui } from './ui.ts'

export type ReviewAction = 'accept' | 'edit' | 'retype' | 'skip' | 'accept-unflagged'

/**
 * Apply one review decision to the rows and return the updated array. Pure
 * apart from retype's name render: the plan file is the caller's to persist.
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
      // Re-render the name from the new type's template; the other rows'
      // names occupy the namespace so the render cannot collide with them.
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

/** One row rendered for the person deciding on it (I3). The flags are the
 *  reason the row needs a person at all, so they carry the warning colour.
 *  `at`/`of` are the row's place in the review, not its index in the plan: a
 *  plan index tells the person nothing about how much is left. */
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
  for (const [k, v] of Object.entries(row.evidence)) {
    if (v) lines.push(u.row('    ', [u.dim(`evidence ${k}:`), v]))
  }
  return lines.join('\n')
}

/**
 * Review the plan file of `folder`: present every pending row (flagged first,
 * I3), apply the keys read from stdin and write the updated plan back. Keys
 * are consumed as they arrive; `e` and `t` take the rest of the line as their
 * value. EOF ends the review.
 */
export async function review(folder: string, config: Config, u: Ui): Promise<void> {
  const planPath = `${folder}/${PLAN_FILE}`
  if (!(await Bun.file(planPath).exists())) {
    throw new Error(`review: no plan file at ${planPath} — run docnamer plan first`)
  }
  let rows = JSON.parse(await Bun.file(planPath).text()) as PlanRow[]
  // Flagged rows are where a person is needed; they go first (I3).
  const order = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === 'pending')
    .sort((a, b) => Number(b.row.flags.length > 0) - Number(a.row.flags.length > 0))

  u.log(u.head(`Reviewing ${order.length} pending row(s)`, planPath))
  u.log(
    u.dim('keys: Enter accept · s skip · e edit name · t retype · A accept all unflagged · q quit')
  )

  const stdin = process.stdin
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
  try {
    let cursor = 0
    const show = () => {
      const item = order[cursor]
      if (item) u.log(renderRow(item.row, cursor + 1, order.length, u))
    }
    show()
    const decoder = new TextDecoder()
    // The same reader the picker and the prompts use: a second consumer of
    // Bun's stdin stream takes the lock the first one holds and throws.
    for (;;) {
      const chunk = await nextStdinChunk()
      if (chunk === null) break
      const text = decoder.decode(chunk)
      let stop = false
      for (let i = 0; i < text.length && !stop; i++) {
        // charAt returns '' past the end, which the loop bound already excludes.
        const ch = text.charAt(i)
        const item = order[cursor]
        if (ch === 'q') {
          stop = true
        } else if (ch === 'A') {
          // SAFE: 'accept-unflagged' sweeps every pending unflagged row and never
          // reads the index; the cursor's row is passed only because applyAction
          // takes one, and past the last row there is none, so 0 stands in.
          rows = await applyAction(rows, item?.index ?? 0, 'accept-unflagged', null, config)
        } else if (item) {
          // Enter accepts the row on screen (R4/I3). A raw-mode terminal sends
          // CR; a piped line sends LF. Both are Enter, and neither is a skip.
          if (ch === '\r' || ch === '\n') {
            rows = await applyAction(rows, item.index, 'accept', null, config)
            cursor++
            show()
          } else if (ch === 's') {
            rows = await applyAction(rows, item.index, 'skip', null, config)
            cursor++
            show()
          } else if (ch === 'e' || ch === 't') {
            const rest = text.slice(i + 1)
            const end = rest.search(/[\r\n]/)
            const value = (end < 0 ? rest : rest.slice(0, end)).trim()
            i = text.length // value runs to the chunk's end of line
            rows = await applyAction(
              rows,
              item.index,
              ch === 'e' ? 'edit' : 'retype',
              value,
              config
            )
            cursor++
            show()
          }
        }
      }
      if (stop) break
    }
  } finally {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
  }

  await writePlan(folder, rows)
  const accepted = rows.filter(r => r.status === 'accepted').length
  const skipped = rows.filter(r => r.status === 'skipped').length
  const pending = rows.filter(r => r.status === 'pending').length
  u.log(u.ok(`review done: ${accepted} accepted, ${skipped} skipped, ${pending} pending`))
}
