/**
 * E2E flow test for interaction I7 — "Finder collision suffix is not a version"
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * The digraph is entry -> step -> outcome. This file is those harness steps
 * in that order, then the assertion of the Outcome: planning a file whose old
 * name ends in ` (2)` and states no version proposes a name with no version
 * field; a second file that renders that same name still receives a Finder
 * ` (2)` collision suffix.
 *
 * The harness owns booting, seeding, the CLI and reading the plan. This test
 * only composes its steps and asserts that sentence on the proposed names.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

/** A printed version field is `v3` / `V4` (BRIEF R2), not a Finder collision suffix. */
const VERSION_FIELD = /(?:^|[\s_-])v\d+\b/i

const baseName = (name: string): string => name.split("/").pop() ?? name

/** `stem (2).ext` is a Finder collision; the stem is what the two files render. */
const parts = (name: string): { stem: string; n: string | null; ext: string } => {
  const base = baseName(name)
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot) : ""
  const stemPart = dot > 0 ? base.slice(0, dot) : base
  const m = stemPart.match(/^(.*) \((\d+)\)$/)
  if (m?.[1] !== undefined && m[2] !== undefined) return { stem: m[1], n: m[2], ext }
  return { stem: stemPart, n: null, ext }
}

flow("naming-rules I7: Finder collision suffix is not a version", async () => {
  const s = new Session("I7")
  await entry(s)
  await step(s)
  await outcome(s)

  const fromFinder = s.plan.filter(r => / \(2\)(\.[^.]+)?$/.test(baseName(r.old)))
  if (fromFinder.length === 0) {
    throw new Error(
      `I7: plan has no row whose old name ends in Finder (2); got ${s.plan.map(r => r.old).join(", ")}`
    )
  }
  for (const row of fromFinder) {
    const proposed = baseName(row.new)
    if (VERSION_FIELD.test(proposed)) {
      throw new Error(
        `I7: ${baseName(row.old)} states no version, but the proposed name ${proposed} prints a version field`
      )
    }
  }

  const parsed = s.names.map(parts)
  const clash = parsed.some(
    (a, i) =>
      a.n === null &&
      parsed.some((b, j) => j !== i && b.stem === a.stem && b.ext === a.ext && b.n === "2")
  )
  if (!clash) {
    throw new Error(
      `I7: a second file that renders the same name must still receive a Finder (2) collision suffix; got ${s.names.join(", ")}`
    )
  }
})
