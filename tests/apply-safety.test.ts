// Safety invariants of apply/undo: the undo record is written before the first
// rename and extended per rename, and no plan row or undo record may move or
// delete a path outside the folder. Harness and fixtures are apply.test.ts's.
import { rmSync } from 'node:fs'
import { expect, test } from 'bun:test'
import {
  CONFIG,
  PLAN,
  loadCommands,
  referenceOutput,
  seed,
  writeAcceptedPlan,
  latestUndo,
  type UndoRecord
} from './apply-harness.ts'

/** The first `n` names of the reference's truth set. */
const someFixtures = (n: number): string[] => referenceOutput().slice(0, n)

/** Overwrite dir's plan file with `rows` after the caller tampered with them. */
async function rewritePlan(dir: string, rows: unknown): Promise<void> {
  await Bun.write(`${dir}/${PLAN}`, JSON.stringify(rows, null, 2) + '\n')
}

/** Read dir's latest undo record, failing the test when there is none. */
async function readRecord(dir: string): Promise<UndoRecord> {
  const name = await latestUndo(dir)
  if (name === null) throw new Error('no undo record in the folder')
  return JSON.parse(await Bun.file(`${dir}/${name}`).text()) as UndoRecord
}

test('apply extends the undo record per rename, so a mid-run failure keeps it', async () => {
  const c = await loadCommands()
  const fixtures = someFixtures(2)
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  // The second row's target sits in a directory that does not exist: mv fails
  // after the first row has been renamed and recorded.
  rows[1]!.new = `nosuchdir/${rows[1]!.new}`
  await rewritePlan(dir, rows)

  await expect(c.apply(dir, CONFIG)).rejects.toThrow()

  const record = await readRecord(dir)
  expect(record.entries.map(e => e.old)).toEqual([rows[0]!.old])
  expect(await Bun.file(`${dir}/${rows[0]!.new}`).exists()).toBe(true)
})

test('apply refuses a row whose path is absolute or escapes the folder, and applies the rest', async () => {
  const c = await loadCommands()
  const fixtures = someFixtures(3)
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  rows[1]!.new = `../escape-${process.pid}.pdf`
  const absolute = `/tmp/docnamer-apply-safety-${process.pid}.pdf`
  rows[2]!.new = absolute
  await rewritePlan(dir, rows)

  const report = await c.apply(dir, CONFIG)

  expect(report.renamed).toBe(1)
  expect(report.skipped.map(s => s.file).sort()).toEqual([rows[1]!.old, rows[2]!.old].sort())
  for (const s of report.skipped) expect(s.reason).toContain('escapes the folder')
  // Nothing landed outside the folder.
  expect(await Bun.file(`${dir}/${rows[1]!.new}`).exists()).toBe(false)
  expect(await Bun.file(absolute).exists()).toBe(false)
  // The record holds only the row that really moved, and survives the skips.
  const record = await readRecord(dir)
  expect(record.entries.map(e => e.old)).toEqual([rows[0]!.old])
})

test('undo refuses a record whose entry path escapes the folder, touching nothing', async () => {
  const c = await loadCommands()
  const fixtures = someFixtures(2)
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  await c.apply(dir, CONFIG)
  const name = await latestUndo(dir)
  if (name === null) throw new Error('no undo record in the folder')
  const record = await readRecord(dir)
  record.entries[0]!.new = '../evil.pdf'
  await Bun.write(`${dir}/${name}`, JSON.stringify(record, null, 2) + '\n')

  await expect(c.undo(dir, null, CONFIG)).rejects.toThrow('outside the folder')

  // Nothing was replayed and the record was kept: both renamed files remain.
  expect(await Bun.file(`${dir}/${rows[0]!.new}`).exists()).toBe(true)
  expect(await Bun.file(`${dir}/${rows[1]!.new}`).exists()).toBe(true)
  expect(await Bun.file(`${dir}/${name}`).exists()).toBe(true)
})

test('undo keeps the record when an entry is skipped, so the rest can be restored', async () => {
  const c = await loadCommands()
  const fixtures = someFixtures(2)
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  await c.apply(dir, CONFIG)
  const name = await latestUndo(dir)
  if (name === null) throw new Error('no undo record in the folder')
  // A new file took the original name of the FIRST entry restored (the last
  // applied one): its undo is refused while the other entry could still go back.
  const blocked = rows[rows.length - 1]!.old
  await Bun.write(`${dir}/${blocked}`, 'occupies the original name\n')

  const report = await c.undo(dir, null, CONFIG)

  expect(report.skipped.map(s => s.file)).toEqual([blocked])
  expect(report.restored.length).toBe(1)
  // The record must survive, or the refused entry can never be undone again.
  expect(await Bun.file(`${dir}/${name}`).exists()).toBe(true)

  // With the way cleared, a second undo restores the entry that was refused.
  rmSync(`${dir}/${blocked}`)
  const again = await c.undo(dir, null, CONFIG)
  expect(again.skipped).toEqual([])
  expect(again.restored).toEqual([blocked])
  expect(await Bun.file(`${dir}/${name}`).exists()).toBe(false)
})

test('undo restores the file but never deletes a sidecar outside the folder', async () => {
  const c = await loadCommands()
  const fixtures = someFixtures(1)
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  await c.apply(dir, CONFIG)
  const sentinel = `/tmp/docnamer-sidecar-safety-${process.pid}.txt`
  await Bun.write(sentinel, 'do not delete me\n')
  const record = await readRecord(dir)
  record.entries[0]!.sidecar = sentinel
  const name = await latestUndo(dir)
  if (name === null) throw new Error('no undo record in the folder')
  await Bun.write(`${dir}/${name}`, JSON.stringify(record, null, 2) + '\n')

  const report = await c.undo(dir, null, CONFIG)

  expect(report.restored).toEqual([rows[0]!.old])
  expect(await Bun.file(sentinel).exists()).toBe(true)
  expect(await Bun.file(`${dir}/${rows[0]!.old}`).exists()).toBe(true)
})
