/**
 * Stage 4 naming: render the type's template with the checked field values,
 * sanitise the result, clamp it to the configured length and disambiguate
 * collisions with a Finder-style " (2)". Two documents that render the same
 * name are made unique by the caller's `planned` set. Nothing is renamed here.
 */
import type { Config } from './config.ts'
import type { Checked } from './validate.ts'

/** A photo or other non-document stays within this many characters, extension included. */
const PHOTO_CAP = 100

/** Person tokens a filename may carry, longest first so Jacqui is not read as Jac. */
const PERSONS = ['Jacqui', 'Jac', 'TM'] as const

/** Substitute {field} placeholders; unknown or null fields become empty. */
export function renderTemplate(t: string, fields: Record<string, string>): string {
  // SAFE: a template may name a field the type never declared, or one the model
  // did not extract; an empty substitution is what the template asked for, and
  // validate() flags a missing required field separately.
  return t.replace(/\{(\w+)\}/g, (_m, name: string) => fields[name] ?? '')
}

/** Remove characters a filesystem forbids in a name, and tidy whitespace. */
export function sanitise(s: string): string {
  return s
    .replace(/[/:*?"<>|\\]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
}

export type NameTokens = {
  version: string | null
  status: string | null
  person: string | null
}

/** A token bounded by non-alphanumerics, or by either end of `stem`. */
const bounded = (stem: string, token: string): boolean => {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${token}(?=$|[^A-Za-z0-9])`, 'i')
  return re.test(stem)
}

/**
 * Version, status and person printed in the filename itself, not in a parent
 * directory. A Finder collision suffix ` (2)` immediately before the extension
 * is not a version.
 */
export const tokensFromName = (fileName: string): NameTokens => {
  const slash = fileName.lastIndexOf('/')
  const base = slash < 0 ? fileName : fileName.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const withoutClash = stem.replace(/ \(\d+\)$/, '')
  const version = /(?:^|[^A-Za-z0-9])([vV]\d+)(?=$|[^A-Za-z0-9])/.exec(withoutClash)?.[1] ?? null
  const status = bounded(stem, 'draft') ? 'draft' : null
  const person = PERSONS.find(p => bounded(stem, p)) ?? null
  return { version, status, person }
}

const shortenAgency = (agency: string): string => {
  if (agency === 'Immigration And Naturalisation Service') return 'IND'
  const words = agency.split(/\s+/).filter(w => w !== '')
  return words.length > 1 ? (words[0] ?? agency) : agency
}

const blank = (v: string | undefined): boolean => v === undefined || v === ''

const fillIfBlank = (fields: Record<string, string>, key: string, value: string | null): void => {
  if (!blank(fields[key])) return
  fields[key] = value ?? ''
}

/** First non-empty string. An empty result is what a missing token prints. */
const firstText = (a: string | undefined, b: string | null | undefined): string => {
  if (a !== undefined && a !== '') return a
  if (b !== null && b !== undefined && b !== '') return b
  return ''
}

const nameOrDocument = (summary: string): string => {
  const tidy = sanitise(summary)
  if (tidy !== '') return tidy
  return 'document'
}

/** Filename tokens fill only fields the model left empty. A passport with no holder takes the person. */
const applyFilenameTokens = (
  fields: Record<string, string>,
  type: string,
  tokens: NameTokens | null
): void => {
  if (tokens !== null) {
    fillIfBlank(fields, 'version', tokens.version)
    fillIfBlank(fields, 'status', tokens.status)
    fillIfBlank(fields, 'person', tokens.person)
  }
  if (type === 'passport' && blank(fields.holder)) {
    fields.holder = firstText(fields.person, tokens?.person)
  }
  if (!blank(fields.agency)) fields.agency = shortenAgency(fields.agency ?? '')
}

const nameFits = (base: string, ext: string, cap: number): boolean =>
  base.length + ext.length <= cap

/** Pop subject words and re-render until the name fits, or no words remain. */
const dropSubjectWords = (
  start: string,
  fields: Record<string, string>,
  compose: () => string,
  ext: string,
  cap: number
): string => {
  let base = start
  if (nameFits(base, ext, cap)) return base
  const words = (fields.subject ?? '').split(/\s+/).filter(w => w !== '')
  while (words.length > 0 && !nameFits(base, ext, cap)) {
    words.pop()
    fields.subject = words.join(' ')
    base = compose()
  }
  return base
}

const dropNumber = (
  base: string,
  fields: Record<string, string>,
  compose: () => string,
  ext: string,
  cap: number
): string => {
  if (nameFits(base, ext, cap)) return base
  if (blank(fields.number)) return base
  fields.number = ''
  return compose()
}

const cutToCap = (base: string, ext: string, cap: number): string => {
  const cut = sanitise(base.slice(0, Math.max(0, cap - ext.length)))
  if (cut !== '') return cut
  return 'document'
}

/** Drop subject words, then the number, then cut, until `base` plus the extension fits `cap`. */
const shrinkToCap = (
  start: string,
  fields: Record<string, string>,
  compose: () => string,
  cap: number,
  ext: string,
  summary: string
): string => {
  if (nameFits(start, ext, cap)) return start
  let base = dropSubjectWords(start, fields, compose, ext, cap)
  base = dropNumber(base, fields, compose, ext, cap)
  if (base === '') base = nameOrDocument(summary)
  if (!nameFits(base, ext, cap)) return cutToCap(base, ext, cap)
  return base
}

/** Case-insensitive Finder collision: `name.ext`, then `name (2).ext`. Adds nothing to `planned`. */
const withCollisionSuffix = (
  base: string,
  ext: string,
  cap: number,
  planned: Set<string>
): string => {
  const occupied = new Set<string>()
  for (const n of planned) occupied.add(n.toLowerCase())
  const room = cap - ext.length
  let name = base.slice(0, room) + ext
  for (let n = 2; occupied.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, room - suffix.length) + suffix + ext
  }
  return name
}

/** Render the document's new filename (with `file.ext`), unique within
 *  `planned`, which the new name is added to. */
export const buildName = async (
  checked: Checked,
  config: Config,
  file: { dir: string; ext: string; name?: string },
  planned: Set<string>
): Promise<string> => {
  const type = config.types[checked.type]
  if (!type) throw new Error(`buildName: config has no type "${checked.type}"`)

  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(checked.fields)) {
    // SAFE: a field the model could not read is null and validate() has already
    // flagged it; the template drops it rather than aborting the whole rename.
    fields[k] = v.value ?? ''
  }

  const tokens = file.name === undefined ? null : tokensFromName(file.name)
  applyFilenameTokens(fields, checked.type, tokens)

  const compose = (): string => sanitise(renderTemplate(type.template, fields))
  let base = compose()
  if (base === '') base = nameOrDocument(checked.summary)

  // The photo/other cap is a ceiling of its own, not a lift on the configured
  // one: a config that asks for shorter names than PHOTO_CAP gets them.
  const photo = checked.type === 'photo' || checked.type === 'other'
  const cap = photo
    ? Math.min(PHOTO_CAP, config.defaults.max_name_length)
    : config.defaults.max_name_length
  if (base.length + file.ext.length > cap) {
    base = shrinkToCap(base, fields, compose, cap, file.ext, checked.summary)
  }

  // The target filesystem (macOS) is case-insensitive, so collision checks
  // are too — regardless of the casing the caller seeded `planned` with.
  const name = withCollisionSuffix(base, file.ext, cap, planned)
  planned.add(name)
  return name
}
