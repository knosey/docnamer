/**
 * E2E for interaction I3 — Collision-safe unique naming.
 *
 * Outcome: when two documents in the same folder (or one document and an
 * existing file) produce the same rendered name, the later plan row receives a
 * Finder-style " (2)" suffix, and no plan row ever proposes a name already
 * occupied on disk.
 *
 * The harness seeds an identical-content fixture pair (tests/fixtures/) beside
 * its own seed documents, so a correct Stage 4 has to disambiguate them. Its
 * steps drive `docnamer plan <folder>` and observe `.docnamer-plan.json`; this
 * spec calls them in I3's digraph order and asserts the outcome.
 */
import {
  Session,
  entry,
  render,
  collide,
  suffix,
  outcome,
} from "./doc-renamer-pipeline-harness.ts";

function base(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

flow("doc-renamer-pipeline I3: collision-safe unique naming", async () => {
  const s = new Session();
  try {
    await entry(s);
    await render(s);
    await collide(s);
    await suffix(s);
    await outcome(s);
  } catch (e) {
    // An absent `docnamer` CLI is not a named hole here: I3's outcome is a
    // real, observable assertion, and with no plan there is no collision
    // handling to observe. Report it as a failure, not a green.
    if ((e as { skip?: boolean } | null)?.skip) {
      throw new Error(`I3 outcome not demonstrated: ${(e as Error).message}`);
    }
    throw e;
  }

  // The identical-content fixtures collide on a rendered name; the later row
  // must have been suffixed.
  const dup = s.plan.filter((r) => /^dup-invoice/.test(base(r.old)));
  if (dup.length < 2) {
    throw new Error(`I3 outcome: expected the colliding fixture pair, saw ${dup.length} rows`);
  }
  if (!dup.some((r) => / \(\d+\)(\.[^.]*)?$/.test(r.new))) {
    throw new Error(
      "I3 outcome: colliding documents produced no Finder-style ' (2)' suffix: " +
        JSON.stringify(dup.map((r) => r.new)),
    );
  }

  // No plan row may propose a name already occupied on disk.
  const onDisk = new Set([...s.originals.keys()].map((n) => n.toLowerCase()));
  for (const r of s.plan) {
    if (onDisk.has(r.new.toLowerCase())) {
      throw new Error(`I3 outcome: ${r.old} proposes a name already on disk: ${r.new}`);
    }
  }
});
