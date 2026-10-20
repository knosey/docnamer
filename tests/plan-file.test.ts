// The plan file's contract, and the guard that stops a flow from checking the
// product against a list the product itself produced. Both are pure, so this is
// the one place they are pinned without paying for a model run (R2).

import { test, expect } from 'bun:test'
import { assertPlanCovers, base, planRows } from './plan-file.ts'

const row = (old: string) => ({ old })

test('planRows returns the array the product writes, not a copy of it', () => {
  const rows = [row('/tmp/x/a.txt')]
  expect(planRows(rows)).toBe(rows)
})

test('planRows refuses an envelope it did not write, and names its keys', () => {
  expect(() => planRows({ rows: [] })).toThrow(/object with keys rows/)
})

test('planRows refuses an empty object rather than reading it as no rows', () => {
  expect(() => planRows({})).toThrow(/not an array of rows: \{\}/)
})

test('planRows refuses null rather than reading it as no rows', () => {
  expect(() => planRows(null)).toThrow(/not an array of rows: null/)
})

test('base takes the last path segment, and leaves a bare name alone', () => {
  expect(base('/tmp/x/a.txt')).toBe('a.txt')
  expect(base('a.txt')).toBe('a.txt')
})

test('assertPlanCovers refuses a plan that dropped a seeded document, and names it', () => {
  expect(() =>
    assertPlanCovers([row('/tmp/x/a.txt')], ['a.txt', 'b.txt'], 'docnamer.json')
  ).toThrow(/missed 1 seeded file\(s\): b\.txt/)
})

test('assertPlanCovers refuses a row for the folder config, which is not a document', () => {
  const rows = [row('/tmp/x/a.txt'), row('/tmp/x/docnamer.json')]
  expect(() => assertPlanCovers(rows, ['a.txt'], 'docnamer.json')).toThrow(/docnamer\.json a row/)
})

test('assertPlanCovers passes a plan that covers every seeded document', () => {
  const rows = [row('/tmp/x/a.txt'), row('/tmp/x/b.txt')]
  expect(() =>
    assertPlanCovers(rows, ['a.txt', 'b.txt', 'docnamer.json'], 'docnamer.json')
  ).not.toThrow()
})
