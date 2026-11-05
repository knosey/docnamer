/**
 * Smoke test for the naming-rules harness: drives entry → step → outcome on the
 * current tree, twice at once when harness-smoke asks, and writes nothing into
 * the repo except the frame outcome captures.
 *
 * It asserts the harness's own contract (an isolated run that planned a file),
 * not an interaction Outcome. Those assertions belong to the flow specs.
 */
import { Session, entry, outcome, repo, step } from "./naming-rules-harness.ts"

flow("naming-rules harness: plans one seeded file outside the repo", async () => {
  const s = new Session("smoke")
  await entry(s)
  await step(s)
  await outcome(s)

  if (!s.booted) throw new Error("smoke: entry returned with the session not marked booted")
  if (!s.dir.startsWith("/")) throw new Error(`smoke: folder ${s.dir} is not absolute`)
  if (s.dir.startsWith(repo + "/")) {
    throw new Error(`smoke: folder ${s.dir} is inside the repo, so a flow test would write into it`)
  }
  if (s.names.length === 0) throw new Error("smoke: outcome observed no proposed name")
  const seeded = Bun.file(`${s.dir}/invoice-acme-2026-04.txt`)
  if (!(await seeded.exists())) throw new Error("smoke: entry did not seed the file step plans")
})
