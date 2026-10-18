// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`getconf NAME_MAX /`

import { expect, test } from 'bun:test'

/**
 * T5 — Stage 4 naming (R9, R10, R11). `src/name.ts` is the work under test. It
 * is loaded INSIDE each check with a dynamic import, never at the top of the
 * file, so a module that is missing or fails to load is a failed check this
 * suite reports — not an uncaught throw while the file loads.
 *
 * The reference `getconf NAME_MAX /` is the filesystem truth a naming step must
 * respect: no rendered name may exceed it.
 */

// --- consumed shapes (structural mirrors of the interfaces T5 consumes) -----

type FieldSpec = {
  kind: 'text' | 'date' | 'entity' | 'last4'
  required: boolean
  prompt?: string
}
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
type Analysis = {
  type: string
  type_confidence: number
  fields: Record<string, { value: string | null; evidence: string | null }>
  summary: string
}
type Checked = Analysis & { flags: string[] }

type NameModule = {
  buildName(
    checked: Checked,
    config: Config,
    file: { dir: string; ext: string },
    planned: Set<string>
  ): Promise<string>
  sanitise(s: string): string
  renderTemplate(t: string, fields: Record<string, string>): string
}

// --- the reference's own output: the truth this test asserts against --------

/** Run the reference command and return its trimmed stdout: the truth. */
function referenceOutput(): string {
  const argv = reference.split(/\s+/).filter(Boolean)
  if (!argv.length) throw new Error('reference is empty')
  const bin = Bun.which(argv[0]) ?? argv[0]
  const p = Bun.spawnSync([bin, ...argv.slice(1)])
  if (p.exitCode !== 0) {
    throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
  return p.stdout.toString().trim()
}

// --- src/name.ts, loaded as a failed check, never a crash at load -----------

async function loadName(): Promise<NameModule> {
  try {
    return (await import('../src/name.ts')) as unknown as NameModule
  } catch (e) {
    throw new Error('src/name.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
}

// --- fixtures ---------------------------------------------------------------

const CONFIG: Config = {
  defaults: {
    date_format: 'YYYY-MM-DD',
    date_order: 'day-first',
    max_name_length: 150,
    ocr_text_layer: false,
    finder_tags: true,
    finder_comment: false
  },
  models: { cheap: 'cheap-model', vision: 'vision-model', strong: 'strong-model' },
  types: {
    invoice: {
      describe: 'A bill asking for payment for goods or services',
      fields: {
        date: { kind: 'date', required: true },
        vendor: { kind: 'entity', required: true },
        amount: { kind: 'text', required: false }
      },
      template: '{date} {vendor} - Invoice',
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

const CHECKED: Checked = {
  type: 'invoice',
  type_confidence: 0.9,
  fields: {
    date: { value: '2026-04-03', evidence: 'Date: 03/04/2026' },
    vendor: { value: 'Acme', evidence: 'Acme Ltd' },
    amount: { value: '482.50 GBP', evidence: 'Total: 482.50 GBP' }
  },
  summary: 'An invoice from Acme',
  flags: []
}

// --- cases ------------------------------------------------------------------

test('T5 renderTemplate substitutes {field} placeholders', async () => {
  const n = await loadName()
  expect(
    n.renderTemplate('{date} {vendor} - Invoice', { date: '2026-04-03', vendor: 'Acme' })
  ).toBe('2026-04-03 Acme - Invoice')
})

test('T5 sanitise removes characters a filesystem forbids in a name', async () => {
  const n = await loadName()
  const out = n.sanitise('a/b:c*d?"e<f>g|h\\i')
  for (const ch of ['/', ':', '*', '?', '"', '<', '>', '|', '\\']) {
    expect(out.includes(ch)).toBe(false)
  }
})

test('T5 buildName renders the template, keeps the extension and fits NAME_MAX', async () => {
  const n = await loadName()
  const name = await n.buildName(CHECKED, CONFIG, { dir: '/tmp', ext: '.pdf' }, new Set())
  expect(name.endsWith('.pdf')).toBe(true)
  expect(name).toContain('2026-04-03')
  expect(name).toContain('Acme')
  expect(name.length).toBeLessThanOrEqual(Number(referenceOutput()))
})

test("T5 buildName appends a Finder-style ' (2)' when the name is taken", async () => {
  const n = await loadName()
  const first = await n.buildName(CHECKED, CONFIG, { dir: '/tmp', ext: '.pdf' }, new Set())
  const second = await n.buildName(CHECKED, CONFIG, { dir: '/tmp', ext: '.pdf' }, new Set([first]))
  expect(second).not.toBe(first)
  expect(second).toMatch(/ \(\d+\)\.pdf$/)
  expect(second.length).toBeLessThanOrEqual(Number(referenceOutput()))
})

test('T5 buildName treats a name differing only in case as taken (macOS is case-insensitive)', async () => {
  const n = await loadName()
  const first = await n.buildName(CHECKED, CONFIG, { dir: '/tmp', ext: '.pdf' }, new Set())
  const second = await n.buildName(
    CHECKED,
    CONFIG,
    { dir: '/tmp', ext: '.pdf' },
    new Set([first.toUpperCase()])
  )
  expect(second).not.toBe(first)
  expect(second).toMatch(/ \(\d+\)\.pdf$/)
})
