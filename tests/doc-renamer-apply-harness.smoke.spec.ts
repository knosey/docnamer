/**
 * Smoke test for the doc-renamer-apply harness: the harness boots a run and
 * stays out of the repo, twice at once, with no program under test built yet
 * (harness-smoke runs before the build).
 *
 * It asserts the harness's OWN contract, not the feature's digraphs. The digraphs
 * are the flow tests, which are red until `apply`/`undo`/`review`/`eval` land —
 * and they must stay red, so nothing here may reach the CLI. `smokePresent`
 * requires this file green, and a smoke that drove I1 would report a skip now and
 * only duplicate the I1 flow test once the CLI exists.
 */
import { CHANGED_FILE, Session, boot, repo } from "./doc-renamer-apply-harness.ts"

flow(
  "doc-renamer-apply harness: boots an isolated run and writes nothing into the repo",
  async () => {
    const s = new Session()
    await boot(s)

    if (!s.booted) throw new Error("smoke: boot returned with the session not marked booted")
    if (!s.dir.startsWith("/")) throw new Error(`smoke: boot's folder ${s.dir} is not absolute`)
    if (s.dir.startsWith(repo + "/")) {
      throw new Error(
        `smoke: boot's folder ${s.dir} is inside the repo, so a flow test would write into it`
      )
    }
    if (s.originals.size === 0) {
      throw new Error("smoke: boot seeded no fixture, so every run would start on an empty folder")
    }

    // Every seeded file is on disk, at the size boot recorded for it: the run's
    // "the originals were not modified" comparison is against these.
    for (const [name, before] of s.originals) {
      const f = Bun.file(`${s.dir}/${name}`)
      if (!(await f.exists())) throw new Error(`smoke: boot recorded ${name} and did not write it`)
      if (f.size !== before.size) {
        throw new Error(
          `smoke: ${name} is ${f.size} bytes on disk and boot recorded ${before.size}`
        )
      }
    }

    // The I1 skip path needs its mutant seeded and recorded, or `check` would
    // have nothing to hold apply to.
    if (!s.originals.has(CHANGED_FILE)) {
      throw new Error(`smoke: boot did not seed ${CHANGED_FILE}, so I1's skip path is untestable`)
    }
  }
)
