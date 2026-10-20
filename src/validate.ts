/**
 * Stage 3 validation: normalise every extracted field by its kind (dates to ISO,
 * entities to their canonical name, last4 to four digits) and cross-check each
 * field's evidence against the document text. Problems become flags on the
 * returned Checked — never a throw, never a silent rewrite.
 *
 * A missing required field is FLAGGED, never a reason to change the type: the
 * type the model read is the type the file is, and the template drops the empty
 * part on its own.
 */
import type { Analysis } from './analyse.ts'
import type { Config, DocType, FieldSpec } from './config.ts'
import type { Content } from './read.ts'

export type Checked = Analysis & { flags: string[] }

/** Month names in English and Dutch, the languages this paperwork is written
 *  in. An abbreviation is any prefix of three letters or more (`Sept`, `okt`). */
const MONTH_NAMES: readonly (readonly string[])[] = [
  ['january', 'januari'],
  ['february', 'februari'],
  ['march', 'maart', 'mrt'],
  ['april'],
  ['may', 'mei'],
  ['june', 'juni'],
  ['july', 'juli'],
  ['august', 'augustus'],
  ['september'],
  ['october', 'oktober'],
  ['november'],
  ['december']
]

/** The month a word names, 1-12, or null when it names none. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return null
  const at = MONTH_NAMES.findIndex(names => names.some(n => n === w || n.startsWith(w)))
  return at < 0 ? null : at + 1
}

/** A printed year as four digits: a two-digit year is this century's unless
 *  that would put it more than a year ahead. */
function fullYear(printed: string): number {
  const n = +printed
  if (printed.length === 4) return n
  return n + (n > (new Date().getFullYear() % 100) + 1 ? 1900 : 2000)
}

/** Years outside this band are implausible for scanned paperwork. */
const MIN_YEAR = 1900

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** One way of printing a date: a pattern and how its groups make the date. */
type DateForm = {
  readonly pattern: RegExp
  read(m: RegExpExecArray, order: 'day-first' | 'month-first'): string | null
}

const ORDINAL = '(?:st|nd|rd|th|e)?'

/**
 * The ways paperwork prints a date, tried in turn. None is anchored: a value
 * copied off the page often carries the place it was signed (`Baambrugge,
 * 8 april 2026`) or its label (`Datum: 21 juni 2026`).
 */
const DATE_FORMS: readonly DateForm[] = [
  // 2026-04-08, 2026/04/08, 2026.04.08
  {
    pattern: /(?:^|\D)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/,
    read: m => iso(+m[1]!, +m[2]!, +m[3]!)
  },
  // 08/04/2026, 08.04.26, 03-04-2026: day or month first by the config
  {
    pattern: /(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/,
    read: (m, order) => {
      const [a, b, y] = [+m[1]!, +m[2]!, fullYear(m[3]!)]
      return order === 'day-first' ? iso(y, b, a) : iso(y, a, b)
    }
  },
  // 8 april 2026, 3rd October 2026, 3 okt. 2026, 8-apr-2026
  {
    pattern: new RegExp(
      `(?:^|[^\\p{L}\\d])(\\d{1,2})${ORDINAL}[\\s-]+(\\p{L}+)\\.?,?[\\s-]+(\\d{4})(?!\\d)`,
      'u'
    ),
    read: m => {
      const month = monthOf(m[2]!)
      return month === null ? null : iso(+m[3]!, month, +m[1]!)
    }
  },
  // October 3, 2026
  {
    pattern: new RegExp(
      `(?:^|[^\\p{L}])(\\p{L}+)\\.?\\s+(\\d{1,2})${ORDINAL},?\\s+(\\d{4})(?!\\d)`,
      'u'
    ),
    read: m => {
      const month = monthOf(m[1]!)
      return month === null ? null : iso(+m[3]!, month, +m[2]!)
    }
  }
]

/** Parse a date string to ISO YYYY-MM-DD, reading ambiguous slashed/dotted
 *  dates by `order`. Returns null on nonsense: a month it does not know is
 *  never guessed. */
export function parseDate(value: string, order: 'day-first' | 'month-first'): string | null {
  for (const form of DATE_FORMS) {
    const m = form.pattern.exec(value)
    const date = m === null ? null : form.read(m, order)
    if (date !== null) return date
  }
  return null
}

const LEGAL_SUFFIX = /\b(ltd|limited|plc|llp|llc|inc|gmbh|uk)\b\.?/gi

const titleCase = (s: string): string =>
  s.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())

/** Canonical roster name for an entity string; unknown names are tidied
 *  (legal suffixes dropped, title-cased). */
export function canonicalEntity(value: string, aliases: Record<string, string[]>): string {
  const v = value.trim()
  const lower = v.toLowerCase()
  for (const [canonical, names] of Object.entries(aliases)) {
    if (canonical.toLowerCase() === lower) return canonical
    for (const alias of names) {
      if (alias.toLowerCase() === lower) return canonical
    }
  }
  return titleCase(
    v
      .replace(LEGAL_SUFFIX, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}

/** The own company `entity` is, when it is one. Both sides go through
 *  `canonicalEntity`, so an alias or a legal suffix matches its company. */
function ownCompany(entity: string, config: Config): string | null {
  const lower = entity.toLowerCase()
  for (const own of config.self ?? []) {
    if (canonicalEntity(own, config.entities).toLowerCase() === lower) return own
  }
  return null
}

/** Reduce a card/account reference to its last four digits. */
export function reduceLast4(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.slice(-4)
}

/** A date as ISO, or null when it cannot be read; an implausible year is
 *  kept and flagged. */
function dateValue(name: string, value: string, config: Config, flags: string[]): string | null {
  const parsed = parseDate(value, config.defaults.date_order)
  if (parsed === null) {
    flags.push(`field ${name}: unparseable date "${value}"`)
    return null
  }
  const year = +parsed.slice(0, 4)
  if (year < MIN_YEAR || year > new Date().getFullYear() + 1) {
    flags.push(`field ${name}: implausible date ${parsed}`)
  }
  return parsed
}

/** One field's value normalised by its kind, with the flags that raises. */
function normalise(
  name: string,
  value: string,
  spec: FieldSpec | undefined,
  config: Config,
  flags: string[]
): string | null {
  if (spec?.kind === 'date') return dateValue(name, value, config, flags)
  if (spec?.kind === 'entity') return canonicalEntity(value, config.entities)
  return spec?.kind === 'last4' ? reduceLast4(value) : value
}

/**
 * A field naming one of the person's own companies gives way to the field its
 * spec names: an invoice Knosey issued is named after the customer it bills.
 * This is decided here and not by the model: told about the own companies, the
 * model named Once as the issuer of an invoice Initech sent to Once (3 of 3
 * runs). With nothing to give way to, the row is flagged for a person.
 */
function preferCounterparty(
  fields: Analysis['fields'],
  spec: DocType | undefined,
  config: Config,
  flags: string[]
): void {
  for (const [name, field] of Object.entries(spec?.fields ?? {})) {
    if (field.counterparty === undefined) continue
    const flag = giveWay(fields, name, field.counterparty, config)
    if (flag !== null) flags.push(flag)
  }
}

/** Put `other`'s value in `name` when `name` is an own company and `other` is
 *  not; the flag when `name` is one and nothing can take its place. */
function giveWay(
  fields: Analysis['fields'],
  name: string,
  other: string,
  config: Config
): string | null {
  const own = ownCompany(fields[name]?.value ?? '', config)
  if (own === null) return null
  const instead = fields[other]
  if (instead?.value && ownCompany(instead.value, config) === null) {
    fields[name] = instead
    return null
  }
  return `field ${name}: names your own company ${own}`
}

/** Normalise every field by kind, cross-check evidence against the document
 *  text, and collect the flags. */
export function validate(a: Analysis, content: Content, config: Config): Checked {
  const flags: string[] = []
  const fields: Analysis['fields'] = {}
  const spec = config.types[a.type]

  if (a.type_confidence < 0.6) {
    flags.push(`unsure of type ${a.type} (confidence ${a.type_confidence})`)
  }

  for (const [name, field] of Object.entries(a.fields)) {
    const fieldSpec = spec?.fields[name]
    const value =
      field.value === null ? null : normalise(name, field.value, fieldSpec, config, flags)

    if (
      field.evidence !== null &&
      content.method !== 'vision' &&
      !content.text.includes(field.evidence)
    ) {
      flags.push(`field ${name}: evidence not found in document`)
    }

    if (value === null && fieldSpec?.required) {
      flags.push(`missing required field ${name}`)
    }

    fields[name] = { value, evidence: field.evidence }
  }

  preferCounterparty(fields, spec, config, flags)
  return { ...a, fields, flags }
}
