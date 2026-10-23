// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? "python3 -c \"print('Knosey|Once|Saulx|Saulx B.V.|120|{date} {holder} passport|{date} {person} {kind} {agency}|{date} contract {customer} {subject} {status} {version}')\""

import { expect, test } from 'bun:test'
import { BUILTIN_CONFIG } from '../src/config.ts'
import { buildName } from '../src/name.ts'
import type { Content } from '../src/read.ts'
import { validate } from '../src/validate.ts'

const truth = (): string[] => {
  const run = Bun.spawnSync(['sh', '-c', reference], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    throw new Error(`reference exited ${run.exitCode}: ${run.stderr.toString()}`)
  }
  return run.stdout.toString().trim().split('|')
}

const content = (text: string): Content =>
  ({ text, images: [], method: 'text', ocrConfidence: null, pages: 1 }) as Content

test('shipped roster matches the reference', async () => {
  const [a, b, c, d, length, passport, government, contract, ...rest] = truth()
  expect(rest).toEqual([])
  expect(BUILTIN_CONFIG.self).toEqual([a, b, c, d])
  expect(String(BUILTIN_CONFIG.defaults.max_name_length)).toBe(length)
  expect(BUILTIN_CONFIG.types.passport?.template).toBe(passport)
  expect(BUILTIN_CONFIG.types.passport?.fields.date).toEqual(
    expect.objectContaining({ kind: 'date', required: true })
  )
  expect(BUILTIN_CONFIG.types.passport?.fields.holder).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.passport?.fields.holder?.required).not.toBe(true)
  expect(BUILTIN_CONFIG.types.government_letter?.template).toBe(government)
  expect(BUILTIN_CONFIG.types.government_letter?.fields.date).toEqual(expect.objectContaining({ kind: 'date' }))
  expect(BUILTIN_CONFIG.types.government_letter?.fields.person).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.government_letter?.fields.kind).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.government_letter?.fields.agency).toEqual(
    expect.objectContaining({ kind: 'entity', required: true })
  )
  expect(BUILTIN_CONFIG.types.contract?.template).toBe(contract)
  expect(BUILTIN_CONFIG.types.contract?.fields.customer).toEqual(
    expect.objectContaining({ kind: 'entity', required: true, counterparty: 'issuer' })
  )
  expect(BUILTIN_CONFIG.types.contract?.fields.issuer).toEqual(expect.objectContaining({ kind: 'entity' }))
  expect(BUILTIN_CONFIG.types.contract?.fields.issuer?.required).not.toBe(true)
  expect(BUILTIN_CONFIG.types.contract?.fields.subject).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.contract?.fields.status).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.contract?.fields.version).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.photo?.template).toBe('{title}')
  expect(BUILTIN_CONFIG.types.photo?.fields.title).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.photo?.fields.title?.required).not.toBe(true)
  const describe = BUILTIN_CONFIG.types.photo?.describe ?? ''
  const words = describe.trim().split(/\s+/).filter(Boolean)
  expect(words.length).toBeGreaterThanOrEqual(5)
  expect(words.length).toBeLessThanOrEqual(8)
  expect(describe.toLowerCase()).toContain('picture')
  expect(describe.toLowerCase()).toContain('document')
  expect(BUILTIN_CONFIG.types.invoice?.template).toBe('{date} {issuer} invoice {number} {version}')
  expect(BUILTIN_CONFIG.types.invoice?.fields.version).toEqual(expect.objectContaining({ kind: 'text' }))
  expect(BUILTIN_CONFIG.types.invoice?.fields.version?.required).not.toBe(true)

  const text = 'Date: 2026-02-17\nSaulx\nCrowdbuilding\nBased Platform\ndraft\nv1'
  const checked = validate(
    {
      type: 'contract',
      type_confidence: 0.9,
      fields: {
        date: { value: '2026-02-17', evidence: 'Date: 2026-02-17' },
        customer: { value: 'Saulx', evidence: 'Saulx' },
        issuer: { value: 'Crowdbuilding', evidence: 'Crowdbuilding' },
        subject: { value: 'Based Platform', evidence: 'Based Platform' },
        status: { value: 'draft', evidence: 'draft' },
        version: { value: 'v1', evidence: 'v1' }
      },
      summary: 'A contract.'
    },
    content(text),
    BUILTIN_CONFIG
  )
  const name = await buildName(checked, BUILTIN_CONFIG, { dir: '', ext: '.pdf' }, new Set())
  expect(name).toContain('Crowdbuilding')
  expect(name.toLowerCase()).toContain('draft')
  expect(name.toLowerCase()).not.toContain('saulx')
})
