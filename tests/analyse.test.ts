// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun pm ls`

import { expect, test } from 'bun:test'
import { ensureProviderKey } from './preload.ts'

/**
 * T3 — Stage 2: classify-and-extract model call (R3, R6).
 *
 * `src/analyse.ts` is the work under test. It is loaded INSIDE each check with a
 * dynamic import, never at the top of the file, so a module that is missing or
 * fails to load is a failed check this suite reports — not an uncaught throw
 * while the file loads, and not a missing command or a crash.
 *
 * The model call is exercised for real against the configured provider (R6, and
 * the "real call, not a fake" mitigation in the BRIEF). When the provider cannot
 * be reached — no credential, for instance — `analyse` is expected to return a
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
}

// Consumed shapes, declared here so this suite loads with no `src/` module
// present (the same names T1/T2 produce; bun strips the types at run time).
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

/** Run the reference command and read what it prints. */
function referenceOutput(): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(reference.split(/\s+/))
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString()
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

test('the model SDK Stage 2 calls is the installed dependency', () => {
  const r = referenceOutput()
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('@earendil-works/pi-ai@1.3.0')
})

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

test('analyse classifies and extracts a text invoice in one model call', async () => {
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
})
