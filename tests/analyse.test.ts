import { expect, test } from 'bun:test'
import { ensureProviderKey, MODEL_CALL_MS } from './preload.ts'

/**
 * src/analyse.ts is loaded INSIDE each check with a dynamic import, never at the top of the file, so a
 * module that is missing or fails to load is a failed check this suite reports — not a throw at load.
 *
 * The model call is exercised for real against the configured provider, never a fake. When the
 * provider cannot be reached — no credential, for instance — `analyse` is expected to return a
 * `Failed`, and this suite names that reason as its failure rather than skipping.
 */

type Analysis = {
  type: string
  type_confidence: number
  fields: Record<string, { value: string | null; evidence: string | null }>
  summary: string
}
type Failed = { failed: true; reason: string; raw: string }
type Analyser = {
  analyse: (content: Content, fileName: string, config: Config) => Promise<Analysis | Failed>
  buildSchema: (types: Record<string, DocType>) => unknown
  isFailed: (r: Analysis | Failed) => r is Failed
  asAnalysis: (args: Record<string, unknown>, types: Record<string, DocType>) => Analysis | string
}

// Declared here so this suite loads with no `src/` module present; bun strips the types at run time.
type FieldSpec = { kind: 'text' | 'date' | 'entity' | 'last4'; required: boolean }
type DocType = {
  describe: string
  fields: Record<string, FieldSpec>
  template: string
  tag?: string
  folder?: string | null
}
type Config = {
  defaults: {
    date_format: string
    date_order: 'day-first' | 'month-first'
    max_name_length: number
    ocr_text_layer: boolean
    finder_tags: boolean
    finder_comment: boolean
  }
  models: { cheap: string; vision: string; strong: string }
  types: Record<string, DocType>
  entities: Record<string, string[]>
}
type Content = {
  text: string
  images: string[]
  method: 'text' | 'ocr' | 'vision'
  ocrConfidence: number | null
  pages: number
}

async function load(): Promise<Analyser> {
  try {
    return (await import('../src/analyse.ts')) as unknown as Analyser
  } catch (e) {
    throw new Error('src/analyse.ts is missing or fails to load: ' + (e as Error).message)
  }
}

const config: Config = {
  defaults: {
    date_format: 'YYYY-MM-DD',
    date_order: 'day-first',
    max_name_length: 150,
    ocr_text_layer: false,
    finder_tags: true,
    finder_comment: false
  },
  models: {
    cheap: 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash',
    vision: 'fireworks/accounts/fireworks/models/qwen3p8-max',
    strong: 'fireworks/accounts/fireworks/models/kimi-k3'
  },
  types: {
    invoice: {
      describe: 'A bill asking for payment for goods or services',
      fields: {
        date: { kind: 'date', required: true },
        vendor: { kind: 'entity', required: true },
        number: { kind: 'text', required: false },
        amount: { kind: 'text', required: false }
      },
      template: '{date} {vendor} - Invoice - {number} - {amount}',
      tag: 'Invoice',
      folder: null
    },
    other: {
      describe: 'Anything that fits no type above',
      fields: { subject: { kind: 'text', required: true } },
      template: '{date} {sender} - {subject}'
    }
  },
  entities: { Acme: ['Acme Ltd', 'ACME'] }
}

const invoiceText = [
  'INVOICE',
  'Acme Ltd',
  'Invoice number: INV-0042',
  'Date: 03/04/2026',
  'Total: 482.50 GBP',
  ''
].join('\n')

const content: Content = {
  text: invoiceText,
  images: [],
  method: 'text',
  ocrConfidence: null,
  pages: 1
}

test('analyse.ts exports its Stage 2 surface', async () => {
  const mod = await load()
  expect(typeof mod.analyse).toBe('function')
  expect(typeof mod.buildSchema).toBe('function')
  expect(typeof mod.isFailed).toBe('function')
})

test('buildSchema enumerates every configured type and its fields', async () => {
  const mod = await load()
  const schema = JSON.stringify(mod.buildSchema(config.types))
  for (const name of Object.keys(config.types)) {
    expect(schema).toContain(name)
  }
  for (const field of Object.keys(config.types.invoice.fields)) {
    expect(schema).toContain(field)
  }
})

test('isFailed distinguishes a Failed from an Analysis', async () => {
  const mod = await load()
  const failed: Failed = { failed: true, reason: 'no credential', raw: '{}' }
  const analysis: Analysis = {
    type: 'invoice',
    type_confidence: 0.9,
    fields: {},
    summary: 'an invoice from Acme'
  }
  expect(mod.isFailed(failed)).toBe(true)
  expect(mod.isFailed(analysis)).toBe(false)
})

// One real paid model call, so it waits past bun's 5s default.
test(
  'analyse classifies and extracts a text invoice in one model call',
  async () => {
    const mod = await load()
    await ensureProviderKey()
    const result = await mod.analyse(content, 'invoice-acme-2026-04.txt', config)
    if (mod.isFailed(result)) {
      throw new Error(
        'Stage 2 analyse returned Failed, so the real model call did not complete: ' +
          result.reason +
          ' — raw: ' +
          result.raw
      )
    }
    expect(result.type).toBe('invoice')
    expect(typeof result.type_confidence).toBe('number')
    expect(result.type_confidence).toBeGreaterThanOrEqual(0)
    expect(result.type_confidence).toBeLessThanOrEqual(1)
    expect(result.fields.vendor.value).toBeTruthy()
    expect(typeof result.fields.vendor.evidence).toBe('string')
    expect(typeof result.summary).toBe('string')
    expect(result.summary.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(20)
  },
  MODEL_CALL_MS
)

// The schema's `fields` object carries every name the roster declares, so a
// reply that fills several types' fields is conforming, not wrong.
test('a reply carrying fields the chosen type does not declare is accepted, and the rest are dropped', async () => {
  const mod = await load()
  const reply = {
    type: 'invoice',
    type_confidence: 0.9,
    summary: 'a bill from Acme',
    fields: {
      date: { value: '2026-04-03', evidence: 'Date: 03/04/2026' },
      vendor: { value: 'Acme', evidence: 'Acme Ltd' },
      number: { value: 'INV-0042', evidence: 'Invoice number: INV-0042' },
      amount: { value: '482.50', evidence: 'Total: 482.50 GBP' },
      agency: { value: 'IND', evidence: 'Immigration And Naturalisation Service' }
    }
  }
  const got = mod.asAnalysis(reply, config.types)
  if (typeof got === 'string') {
    throw new Error(`asAnalysis refused a schema-conforming reply: ${got}`)
  }
  expect(Object.keys(got.fields).sort()).toEqual(['amount', 'date', 'number', 'vendor'])
})
