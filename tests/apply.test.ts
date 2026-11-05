// The whole-run happy paths of apply and undo, asserted against the truth set
// of `ls tests/fixtures` via the shared harness in tests/apply-harness.ts.
import { expect, test } from "bun:test"
import {
  reference,
  CONFIG,
  PLAN,
  loadCommands,
  referenceOutput,
  seed,
  writeAcceptedPlan,
  names,
  latestUndo
} from "./apply-harness.ts"

export { reference }

test("T2 apply renames every accepted row and writes the undo record", async () => {
  const c = await loadCommands()
  const fixtures = referenceOutput()
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)

  const report = await c.apply(dir, CONFIG)

  expect(report.renamed).toBe(rows.length)
  expect(report.undoFile.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect(await Bun.file(`${dir}/${r.new}`).exists()).toBe(true)
    expect(await Bun.file(`${dir}/${r.old}`).exists()).toBe(false)
  }
  // The plan is consumed: it is gone, and a timestamped undo record remains.
  expect(await Bun.file(`${dir}/${PLAN}`).exists()).toBe(false)
  const undo = await latestUndo(dir)
  expect(undo).not.toBeNull()
  expect(await Bun.file(`${dir}/${undo as string}`).exists()).toBe(true)
})

test("T2 undo restores the reference set and deletes the undo record", async () => {
  const c = await loadCommands()
  const fixtures = referenceOutput()
  const dir = await seed(fixtures)
  const rows = await writeAcceptedPlan(dir, fixtures)
  await c.apply(dir, CONFIG)

  const report = await c.undo(dir, null, CONFIG)

  // The report names what came back, not only how many: the summary a person
  // reads has to say which file is sitting at which name (I2).
  expect([...report.restored].sort()).toEqual(rows.map(r => r.old).sort())
  // The truth: the folder holds exactly the fixture names the reference printed.
  expect(await names(dir)).toEqual(fixtures)
  expect(await latestUndo(dir)).toBeNull()
})

test("T2 apply and undo keep a document in its subfolder, never the folder root", async () => {
  const c = await loadCommands()
  const fixture = referenceOutput()[0] as string
  const dir = await seed([fixture], "sub")
  await writeAcceptedPlan(dir, [fixture], "sub")

  const applied = await c.apply(dir, CONFIG)
  expect(applied.renamed).toBe(1)
  expect(await Bun.file(`${dir}/sub/renamed-${fixture}`).exists()).toBe(true)
  expect(await Bun.file(`${dir}/sub/${fixture}`).exists()).toBe(false)
  expect(await Bun.file(`${dir}/renamed-${fixture}`).exists()).toBe(false)

  await c.undo(dir, null, CONFIG)
  expect(await Bun.file(`${dir}/sub/${fixture}`).exists()).toBe(true)
  expect(await Bun.file(`${dir}/sub/renamed-${fixture}`).exists()).toBe(false)
})
