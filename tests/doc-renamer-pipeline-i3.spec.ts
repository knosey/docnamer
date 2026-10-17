/**
 * E2E for interaction I3 — Collision-safe unique naming.
 *
 * Outcome: when two documents in the same folder (or one document and an
 * existing file) produce the same rendered name, the later plan row receives a
 * Finder-style " (2)" suffix, and no plan row ever proposes a name already
 * occupied on disk.
 *
 * Stage 4 keeps each file's own extension (spec line 213), so two documents
 * collide only when the rendered stem AND extension coincide: the
 * identical-content .md/.txt fixture pair never collides. The case that must
 * suffix is a rendered name already taken in the folder. The steps drive
 * `docnamer plan <folder>` and observe `.docnamer-plan.json`; this spec calls
 * them in I3's digraph order and asserts the outcome.
 */
import { Session, entry, render, collide, suffix, outcome } from './doc-renamer-pipeline-harness.ts'

flow('doc-renamer-pipeline I3: collision-safe unique naming', async () => {
  const s = new Session()
  try {
    await entry(s)
    await render(s)
    await collide(s)
    await suffix(s)
    await outcome(s)
  } catch (e) {
    // An absent `docnamer` CLI is not a named hole here: I3's outcome is a
    // real, observable assertion, and with no plan there is no collision
    // handling to observe. Report it as a failure, not a green.
    if ((e as { skip?: boolean } | null)?.skip) {
      throw new Error(`I3 outcome not demonstrated: ${(e as Error).message}`)
    }
    throw e
  }

  // Disambiguation has to have fired on this fixture set: at least one row
  // carries the Finder-style suffix. Which pair collides is the model's
  // business, but with no suffixed row Stage 4's collision path never ran.
  const suffixed = s.plan.filter(r => / \(\d+\)(\.[^.]*)?$/.test(r.new))
  if (!suffixed.length) {
    throw new Error(
      "I3 outcome: no plan row received a Finder-style ' (2)' suffix, so nothing " +
        'exercised disambiguation: ' +
        JSON.stringify(s.plan.map(r => r.new))
    )
  }

  // No plan row may propose a name already occupied on disk.
  const onDisk = new Set([...s.originals.keys()].map(n => n.toLowerCase()))
  for (const r of s.plan) {
    if (onDisk.has(r.new.toLowerCase())) {
      throw new Error(`I3 outcome: ${r.old} proposes a name already on disk: ${r.new}`)
    }
  }
})
