/**
 * An invoice is named after its issuer, except that the person's own companies
 * are never the name: an invoice Knosey issued is named after the customer it
 * bills. The model only reads both parties off the page; which one names the
 * file is decided in validate, because a model told about the own companies
 * named Once as the issuer of an invoice Initech sent to Once, and named a
 * private person as the issuer of a quote a garden designer sent them.
 */
import { expect, test } from 'bun:test'
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

/** An invoice read with `issuer` and `customer` as given, every value in the text. */
function invoice(issuer: string, customer: string | null) {
  const text = `Date: 2026-05-01\n${issuer}\n${customer ?? ''}\nINV-7`
  return validate(
    {
      type: 'invoice',
      type_confidence: 0.9,
      fields: {
        date: { value: '2026-05-01', evidence: 'Date: 2026-05-01' },
        issuer: { value: issuer, evidence: issuer },
        customer: { value: customer, evidence: customer },
        number: { value: 'INV-7', evidence: 'INV-7' }
      },
      summary: 'An invoice.'
    },
    content(text),
    config
  )
}

test('the shipped invoice names its issuer and gives way to its customer', () => {
  const invoiceType = BUILTIN_CONFIG.types.invoice
  expect(invoiceType?.template).toBe('{date} {issuer} invoice {number} {version}')
  expect(invoiceType?.fields.issuer).toEqual(
    expect.objectContaining({ kind: 'entity', counterparty: 'customer' })
  )
  expect(invoiceType?.fields.customer).toEqual(expect.objectContaining({ kind: 'entity' }))
  expect(BUILTIN_CONFIG.self).toEqual(['Knosey', 'Once', 'Saulx', 'Saulx B.V.'])
})

test('an invoice an own company issued is named after its customer, under any alias', () => {
  const checked = invoice('KNOSEY LIMITED', 'Globex Corporation')
  expect(checked.fields.issuer?.value).toBe('Globex Corporation')
  expect(checked.flags).toEqual([])
})

test('an invoice sent to an own company keeps its issuer', () => {
  const checked = invoice('Initech Software Ltd', 'Once Ltd')
  expect(checked.fields.issuer?.value).toBe('Initech Software')
  expect(checked.flags).toEqual([])
})

test('an own company with no customer to give way to is flagged, not kept silently', () => {
  const checked = invoice('Knosey Ltd', null)
  expect(checked.fields.issuer?.value).toBe('Knosey')
  expect(checked.flags).toContain('field issuer: names your own company Knosey')
})

test('an own company in a field that gives way to nothing is not touched', () => {
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
  expect(checked.fields.employer?.value).toBe('Once')
  expect(checked.flags).toEqual([])
})
