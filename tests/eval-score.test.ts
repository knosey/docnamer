// The grading arithmetic, off the wire: `docnamer eval` costs a model call per
// file, so the numbers it prints are scored here against rows written out by
// hand. A metric that counts a part the truth never declared is a wrong number
// in the report a person reads — that is what these pin.

import { expect, test } from 'bun:test'
import type { PlanRow } from '../src/commands.ts'
import { scorePlan } from '../src/eval.ts'

const row = (old: string, fields: { type: string; new: string }): PlanRow => ({
  old,
  new: fields.new,
  type: fields.type,
  method: 'text',
  fields: {},
  evidence: {},
  flags: [],
  summary: '',
  size: 0,
  mtime: 0,
  status: 'pending'
})

test('eval scoring counts type accuracy over the entries the truth declares', async () => {
  const report = scorePlan(
    {
      'a.pdf': { type: 'invoice' },
      'b.pdf': { type: 'receipt' },
      'c.pdf': { name: 'no type declared here.pdf' }
    },
    [
      row('a.pdf', { type: 'invoice', new: 'a.pdf' }),
      row('b.pdf', { type: 'letter', new: 'b.pdf' }),
      row('c.pdf', { type: 'other', new: 'no type declared here.pdf' })
    ],
    3
  )
  expect(report.files).toBe(3)
  expect(report.typeAccuracy, 'one of the two declared types was right').toBe(0.5)
  expect(report.fullNameMatch, 'the only entry with a declared name matched').toBe(1)
})

test('eval scoring counts the name ratio over the entries that declare a name', async () => {
  const report = scorePlan(
    { 'a.pdf': { name: 'right.pdf' }, 'b.pdf': { type: 'invoice' } },
    [
      row('a.pdf', { type: 'invoice', new: 'right.pdf' }),
      row('b.pdf', { type: 'invoice', new: 'b.pdf' })
    ],
    2
  )
  expect(report.fullNameMatch).toBe(1)
  expect(report.typeAccuracy, 'the only declared type was right').toBe(1)
})

test('a truth that declares nothing scores nothing, rather than dividing by the set', async () => {
  const report = scorePlan(
    { 'a.pdf': {}, 'b.pdf': {} },
    [row('a.pdf', { type: 'invoice', new: 'x.pdf' })],
    2
  )
  expect(report.files).toBe(2)
  expect(report.typeAccuracy).toBe(0)
  expect(report.fullNameMatch).toBe(0)
  expect(report.misses).toEqual([])
})
