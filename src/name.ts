/**
 * Stage 4 naming (R9, R10, R11, I3).
 *
 * buildName() renders the type's template with the checked field values,
 * sanitises the result for the filesystem, clamps it to the configured
 * maximum length and disambiguates collisions with a Finder-style " (2)"
 * suffix. Two documents with the same type and field values render to the
 * same name before disambiguation; the `planned` set is what makes them
 * unique (I3). Nothing is renamed here — names only (R11).
 */
import type { Config } from './config.ts'
import type { Checked } from './validate.ts'

/** Substitute {field} placeholders; unknown or null fields become empty. */
export function renderTemplate(t: string, fields: Record<string, string>): string {
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

/**
 * Render the document's new filename (with `file.ext`), unique within
 * `planned`. The final name is added to `planned`; collision checks
 * case-fold, so the set's own casing does not matter.
 */
export async function buildName(
  checked: Checked,
  config: Config,
  file: { dir: string; ext: string },
  planned: Set<string>
): Promise<string> {
  const type = config.types[checked.type] ?? config.types['other']
  if (!type)
    throw new Error(`buildName: config has no type "${checked.type}" and no "other" fallback`)

  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(checked.fields)) {
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
