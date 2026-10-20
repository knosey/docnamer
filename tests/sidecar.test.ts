/**
 * The OCR text layer is a `<file>.ocr.txt` sidecar that `apply` writes beside a
 * scan it renamed. Two things kept those sidecars around as stray `.txt` files:
 *
 *  - `apply` recorded the sidecar's ABSOLUTE path and `undo` joined it onto the
 *    folder again, so `rm -f` removed a path that does not exist, succeeded, and
 *    every sidecar survived the undo under the name the run had given its scan;
 *  - `plan` scanned every non-hidden file, so the next plan read each sidecar
 *    as a text document and proposed a `.txt` name for it.
 */
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { apply, plan, PLAN_FILE, undo, type PlanRow } from '../src/commands.ts'
import { BUILTIN_CONFIG, type Config } from '../src/config.ts'
import { scratch } from './scratch.ts'

const config: Config = {
  ...BUILTIN_CONFIG,
  defaults: {
    ...BUILTIN_CONFIG.defaults,
    ocr_text_layer: true,
    finder_tags: false,
    finder_comment: false
  }
}

/** The folder's visible files, as a person sees them in Finder. */
const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter(n => !n.startsWith('.'))
    .sort()

test('undo removes the OCR sidecar apply wrote, leaving only the original scan', async () => {
  const dir = scratch('docnamer-sidecar')
  const scan = `${dir}/receipt.png`
  await Bun.write(scan, Bun.file(`${import.meta.dir}/fixtures/receipt.png`))
  const f = Bun.file(scan)
  const row: PlanRow = {
    old: 'receipt.png',
    new: '2024-03-12 Acme receipt.png',
    type: 'receipt',
    method: 'ocr',
    fields: {},
    evidence: {},
    flags: [],
    summary: 'A receipt.',
    size: f.size,
    mtime: f.lastModified,
    status: 'accepted'
  }
  await Bun.write(`${dir}/${PLAN_FILE}`, JSON.stringify([row]))

  const applied = await apply(dir, config)
  expect(applied.renamed, `apply skipped: ${JSON.stringify(applied.skipped)}`).toBe(1)
  expect(visible(dir)).toEqual([
    '2024-03-12 Acme receipt.png',
    '2024-03-12 Acme receipt.png.ocr.txt'
  ])

  const undone = await undo(dir, null, config)
  expect(undone.skipped).toEqual([])
  expect(visible(dir), 'an undone run leaves nothing of itself behind').toEqual(['receipt.png'])
}, 60000)

test('plan never proposes a name for an OCR sidecar', async () => {
  const dir = scratch('docnamer-sidecar-plan')
  await Bun.write(`${dir}/2024-03-12 Acme receipt.png.ocr.txt`, 'ACME RECEIPT\nTotal 12.00')
  const rows = await plan(dir, { recursive: false, applyUnflagged: false }, config)
  expect(rows.map(r => r.old)).toEqual([])
})
