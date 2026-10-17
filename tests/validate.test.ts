// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference =
  process.env.GRAPH_REFERENCE ?? String.raw`date -j -f "%Y-%m-%d" "2026-04-03" "+%Y-%m-%d"`

import { test, expect } from 'bun:test'

// --- types (structural mirrors of the interfaces T4 consumes) ---------------

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
type Content = {
  text: string
  images: string[]
  method: 'text' | 'ocr' | 'vision'
  ocrConfidence: number | null
  pages: number
}
type Checked = Analysis & { flags: string[] }

type ValidateModule = {
  validate(a: Analysis, content: Content, config: Config): Checked
  parseDate(value: string, order: 'day-first' | 'month-first'): string | null
  canonicalEntity(value: string, aliases: Record<string, string[]>): string
  reduceLast4(value: string): string
}

// --- the reference's own output: the truth this test asserts against --------

/** Split a shell command string into argv, honouring single/double quotes and
 *  backslash escapes, so the reference runs without a shell (`sh -c`). */
function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      started = true
    } else if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      started = true
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (started) {
        words.push(cur)
        cur = ''
        started = false
      }
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i]
      started = true
    } else {
      cur += c
      started = true
    }
  }
  if (started) words.push(cur)
  return words
}

/** Run the reference command and return its trimmed stdout: the truth. */
async function referenceOutput(): Promise<string> {
  const argv = shellWords(reference)
  if (!argv.length) throw new Error('reference is empty')
  const bin = Bun.which(argv[0]) ?? argv[0]
  const p = Bun.spawnSync([bin, ...argv.slice(1)])
  if (p.exitCode !== 0) {
    throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
  return p.stdout.toString().trim()
}

// --- src/validate.ts, loaded as a failed check, never a crash at load ------

async function loadValidate(): Promise<ValidateModule> {
  try {
    return (await import('../src/validate.ts')) as ValidateModule
  } catch (e) {
    throw new Error('src/validate.ts is not written: ' + ((e as Error)?.message ?? String(e)))
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
      template: '{date} {vendor} - Invoice'
    },
    other: {
      describe: 'Anything that fits no type above',
      fields: {
        date: { kind: 'date', required: false },
        sender: { kind: 'entity', required: false },
        subject: { kind: 'text', required: true }
      },
      template: '{date} {sender} - {subject}'
    }
  },
  entities: {
    Barclays: ['Barclays Bank UK PLC', 'Barclays Bank', 'BARCLAYS'],
    HMRC: ['HM Revenue & Customs', 'HM Revenue and Customs']
  }
}

const CONTENT: Content = {
  text: 'INVOICE Acme Ltd Date: 03/04/2026 Total: 482.50 GBP',
  images: [],
  method: 'text',
  ocrConfidence: null,
  pages: 1
}

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    type: 'invoice',
    type_confidence: 0.9,
    fields: {
      date: { value: '03/04/2026', evidence: 'Date: 03/04/2026' },
      vendor: { value: 'Acme Ltd', evidence: 'Acme Ltd' },
      amount: { value: '£482.50', evidence: 'Total: 482.50 GBP' }
    },
    summary: 'An invoice from Acme',
    ...over
  }
}

const hasFlag = (flags: string[], re: RegExp): boolean => flags.some(f => re.test(f))

// --- cases ------------------------------------------------------------------

test("T4 parseDate matches the reference's ISO truth", async () => {
  const v = await loadValidate()
  const truth = await referenceOutput()
  expect(v.parseDate('03/04/2026', 'day-first')).toBe(truth)
})

test('T4 parseDate reads slashed dates day-first, and month-first when configured', async () => {
  const v = await loadValidate()
  expect(v.parseDate('03/04/2026', 'day-first')).toBe('2026-04-03')
  expect(v.parseDate('03/04/2026', 'month-first')).toBe('2026-03-04')
})

test('T4 parseDate accepts ISO, dotted and month-name dates, and rejects nonsense', async () => {
  const v = await loadValidate()
  expect(v.parseDate('2026-04-03', 'day-first')).toBe('2026-04-03')
  expect(v.parseDate('03.04.2026', 'day-first')).toBe('2026-04-03')
  expect(v.parseDate('12 March 2026', 'day-first')).toBe('2026-03-12')
  expect(v.parseDate('not a date', 'day-first')).toBeNull()
})

test('T4 canonicalEntity resolves aliases and tidies legal suffixes', async () => {
  const v = await loadValidate()
  expect(v.canonicalEntity('BARCLAYS', CONFIG.entities)).toBe('Barclays')
  expect(v.canonicalEntity('Barclays Bank UK PLC', CONFIG.entities)).toBe('Barclays')
  expect(v.canonicalEntity('Acme Ltd', CONFIG.entities)).toBe('Acme')
})

test('T4 reduceLast4 keeps the last four digits', async () => {
  const v = await loadValidate()
  expect(v.reduceLast4('****1234')).toBe('1234')
  expect(v.reduceLast4('Account 0011223344')).toBe('3344')
})

test('T4 validate normalises fields and returns a flags array', async () => {
  const v = await loadValidate()
  const checked = v.validate(analysis(), CONTENT, CONFIG)
  expect(Array.isArray(checked.flags)).toBe(true)
  expect(checked.flags).toEqual([])
  expect(checked.fields.date.value).toBe('2026-04-03')
  expect(checked.fields.amount.value).toBe('£482.50')
  expect(checked.fields.vendor.value).toBe('Acme')
})

test('T4 validate flags low type confidence', async () => {
  const v = await loadValidate()
  const checked = v.validate(analysis({ type_confidence: 0.4 }), CONTENT, CONFIG)
  expect(hasFlag(checked.flags, /unsure|confidence/i)).toBe(true)
})

test('T4 validate flags a missing required field without changing the type', async () => {
  const v = await loadValidate()
  const a = analysis({
    fields: {
      date: { value: null, evidence: null },
      vendor: { value: 'Acme', evidence: 'Acme Ltd' },
      amount: { value: null, evidence: null }
    }
  })
  const checked = v.validate(a, CONTENT, CONFIG)
  expect(hasFlag(checked.flags, /missing.*date/i)).toBe(true)
  // The type the model read IS the type the file is. Rewriting it to `other`
  // threw away every value that WAS extracted — a statement with no account
  // number rendered as a bare date.
  expect(checked.type).toBe('invoice')
})

test('T4 validate flags evidence that is not in the document', async () => {
  const v = await loadValidate()
  const a = analysis({
    fields: {
      date: { value: '03/04/2026', evidence: 'Date: 03/04/2026' },
      vendor: { value: 'Acme', evidence: 'Acme Ltd' },
      amount: { value: '999.00 GBP', evidence: 'Total: 999.00 GBP' }
    }
  })
  const checked = v.validate(a, CONTENT, CONFIG)
  expect(hasFlag(checked.flags, /evidence/i)).toBe(true)
})

test('T4 validate flags an implausible date', async () => {
  const v = await loadValidate()
  const a = analysis({
    fields: {
      date: { value: '1800-01-01', evidence: 'Date: 03/04/2026' },
      vendor: { value: 'Acme', evidence: 'Acme Ltd' },
      amount: { value: '482.50 GBP', evidence: 'Total: 482.50 GBP' }
    }
  })
  const checked = v.validate(a, CONTENT, CONFIG)
  expect(hasFlag(checked.flags, /date/i)).toBe(true)
})
