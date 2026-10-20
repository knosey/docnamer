/**
 * Stage 4 naming: render the type's template with the checked field values,
 * sanitise the result, clamp it to the configured length and disambiguate
 * collisions with a Finder-style " (2)". Two documents that render the same
 * name are made unique by the caller's `planned` set. Nothing is renamed here.
 */
import type { Config } from './config.ts'
import type { Checked } from './validate.ts'

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

/** Render the document's new filename (with `file.ext`), unique within
 *  `planned`, which the new name is added to. */
export async function buildName(
  checked: Checked,
  config: Config,
  file: { dir: string; ext: string },
  planned: Set<string>
): Promise<string> {
  const type = config.types[checked.type]
  if (!type) throw new Error(`buildName: config has no type "${checked.type}"`)

  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(checked.fields)) {
    // SAFE: a field the model could not read is null and validate() has already
    // flagged it; the template drops it rather than aborting the whole rename.
    fields[k] = v.value ?? ''
  }

  let base = sanitise(renderTemplate(type.template, fields))
  if (!base) base = sanitise(checked.summary) || 'document'

  const max = config.defaults.max_name_length
  const ext = file.ext
  const room = () => max - ext.length

  // The target filesystem (macOS) is case-insensitive, so collision checks
  // are too — regardless of the casing the caller seeded `planned` with.
  const occupied = new Set<string>()
  for (const n of planned) occupied.add(n.toLowerCase())
  const taken = (n: string) => occupied.has(n.toLowerCase())
  let name = base.slice(0, room()) + ext
  for (let n = 2; taken(name); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, room() - suffix.length) + suffix + ext
  }
  planned.add(name)
  return name
}
