/**
 * The rows `docnamer plan` wrote, and the checks the harnesses make against them.
 *
 * The plan file is a bare JSON array: `writePlan` in `src/commands.ts` is the
 * only writer in the tree and it writes `JSON.stringify(rows, null, 2)`. Anything
 * else is a contract break and this throws. All three call sites used to fall back
 * to `[]`, which turned a shape we had guessed wrong into an empty plan: every
 * later step then looped over nothing and passed. A hole that is neither green nor
 * red is worse than a red, because nobody goes looking for it (R2).
 *
 * One owner, three call sites: two of them were near-copies that had already
 * drifted apart — the second accepted `rows` but not `files`, for the same file.
 */
export function planRows<T>(parsed: unknown): T[] {
  if (Array.isArray(parsed)) return parsed as T[]
  const keys = parsed !== null && typeof parsed === 'object' ? Object.keys(parsed).join(', ') : ''
  throw new Error(
    keys
      ? `the plan file is not an array of rows: it is an object with keys ${keys}`
      : `the plan file is not an array of rows: ${JSON.stringify(parsed)}`
  )
}

/** The last path segment: a row's `old` carries the folder it was found in. */
export function base(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] ?? p
}

/**
 * Every seeded document has a row, and the folder's own config does not.
 *
 * The plan is the expectation every later step asserts against, so it has to earn
 * that trust first: a `plan` that silently dropped a seeded document would shrink
 * the expectation to whatever it did return, and the steps downstream would then be
 * checking the product against a list the product itself produced (F6).
 */
export function assertPlanCovers<T extends { old: string }>(
  rows: T[],
  seeded: Iterable<string>,
  configFile: string
): void {
  const planned = new Set(rows.map(r => base(r.old)))
  const missing = [...seeded].filter(n => n !== configFile && !planned.has(n))
  if (missing.length) {
    throw new Error(`the plan missed ${missing.length} seeded file(s): ${missing.join(', ')}`)
  }
  if (planned.has(configFile)) {
    throw new Error(`the plan gave ${configFile} a row: the folder's own config is not a document`)
  }
}
