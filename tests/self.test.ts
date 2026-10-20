/**
 * The person's own companies are never the company a document is named after
 * when the field names the other side of it. An invoice Knosey issued is named
 * after the customer it bills; one sent to Knosey after its issuer. A payslip
 * from Knosey still names Knosey: `employer` is not a counterparty field.
 */
import { expect, test } from 'bun:test'
import { buildSchema, selfRule } from '../src/analyse.ts'
import { BUILTIN_CONFIG, type Config } from '../src/config.ts'
import type { Content } from '../src/read.ts'
import { validate } from '../src/validate.ts'

const content = (text: string): Content =>
  ({ text, images: [], method: 'text', ocrConfidence: null, pages: 1 }) as Content

const config: Config = {
  ...BUILTIN_CONFIG,
  self: ['Knosey', 'Once'],
  entities: { ...BUILTIN_CONFIG.entities, Knosey: ['Knosey Ltd', 'Knosey Limited'] }
}

test('the shipped invoice is named after its counterparty, and the own companies are listed', () => {
  const invoice = BUILTIN_CONFIG.types.invoice
  expect(invoice?.template).toBe('{date} {party} invoice {number}')
  expect(invoice?.fields.party).toEqual(
    expect.objectContaining({ kind: 'entity', counterparty: true })
  )
  expect(BUILTIN_CONFIG.self).toEqual(['Knosey', 'Once'])
})

test('a counterparty field naming an own company is flagged, under any alias', () => {
  const checked = validate(
    {
      type: 'invoice',
      type_confidence: 0.9,
      fields: {
        date: { value: '2026-05-01', evidence: 'Date: 2026-05-01' },
        party: { value: 'KNOSEY LIMITED', evidence: 'KNOSEY LIMITED' },
        number: { value: 'INV-7', evidence: 'INV-7' }
      },
      summary: 'An invoice.'
    },
    content('Date: 2026-05-01\nKNOSEY LIMITED\nINV-7'),
    config
  )
  expect(checked.fields.party?.value).toBe('Knosey')
  expect(checked.flags).toContain('field party: names your own company Knosey')
})

test('an own company in a field that is not a counterparty is not flagged', () => {
  const checked = validate(
    {
      type: 'payslip',
      type_confidence: 0.9,
      fields: {
        date: { value: '2026-05-01', evidence: 'Date: 2026-05-01' },
        employer: { value: 'Once', evidence: 'Once' }
      },
      summary: 'A payslip.'
    },
    content('Date: 2026-05-01\nOnce'),
    config
  )
  expect(checked.flags.filter(f => f.includes('own company'))).toEqual([])
})

test('the model is told which companies are the person own and which fields avoid them', () => {
  const rule = selfRule(config)
  expect(rule).toContain('Knosey, Once')
  expect(rule).toContain('party (invoice, contract)')
  expect(selfRule({ ...config, self: [] }), 'no own companies, no rule').toBe('')
})

test('the rule rides on the counterparty field itself, and only there', () => {
  type Field = { properties: { value: { description: string } } }
  const fields = (
    buildSchema(config.types, config.self) as {
      properties: { fields: { properties: Record<string, Field> } }
    }
  ).properties.fields.properties
  expect(fields.party?.properties.value.description).toContain('Never one of the person')
  expect(fields.employer?.properties.value.description).not.toContain('Knosey')
})
