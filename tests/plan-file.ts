/**
 * The rows `docnamer plan` wrote, from the envelope it chose to write them in.
 *
 * The envelope is the product's contract, so an unrecognized one is a contract
 * break and this throws. All three call sites used to fall back to `[]`, which
 * turned a shape we had guessed wrong into an empty plan: every later step then
 * looped over nothing and passed. A hole that is neither green nor red is worse
 * than a red, because nobody goes looking for it (R2).
 *
 * One owner, three call sites: two of them were near-copies that had already
 * drifted apart — the second accepted `rows` but not `files`, for the same file.
 */
export function planRows<T>(parsed: unknown): T[] {
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed !== null && typeof parsed === 'object') {
    const envelope = parsed as { rows?: unknown; files?: unknown }
    if (Array.isArray(envelope.rows)) return envelope.rows as T[]
    if (Array.isArray(envelope.files)) return envelope.files as T[]
    const keys = Object.keys(parsed)
    throw new Error(
      keys.length
        ? `the plan file carries no rows: it is an object with keys ${keys.join(', ')}`
        : 'the plan file carries no rows: it is an empty object'
    )
  }
  throw new Error(`the plan file is neither an array nor an object: ${JSON.stringify(parsed)}`)
}
