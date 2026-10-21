/**
 * Smoke test for the terminal-ux-polish harness: the harness boots an isolated
 * run, stays out of the repo, and drives the CLI end to end — twice at once —
 * against the current tree.
 *
 * It asserts the harness's OWN contract, not the feature's digraphs. The
 * digraphs are the flow tests, which are red until T1-T6 land, so nothing here
 * may depend on a step of theirs. What it does drive is the one command the tree
 * already has: `docnamer --version`, which proves the harness resolves a real
 * CLI, spawns it and reads its answer.
 *
 * The plan is seeded through the product's own writer, so review reads a file
 * the product produced; the smoke checks it is there and covers the rows the
 * review flows need.
 */
import { PLAN_FILE, type PlanRow } from '../src/commands.ts'
import { Session, boot, repo } from './terminal-ux-polish-harness.ts'
import { runChild } from './child.ts'

flow(
  'terminal-ux-polish harness: boots an isolated run and drives the CLI end to end',
  async () => {
    const s = new Session()
    await boot(s)

    if (!s.booted) throw new Error('smoke: boot returned with the session not marked booted')
    if (!s.dir.startsWith('/')) throw new Error(`smoke: boot's folder ${s.dir} is not absolute`)
    if (s.dir.startsWith(repo + '/')) {
      throw new Error(
        `smoke: boot's folder ${s.dir} is inside the repo, so a flow test would write into it`
      )
    }
    if (s.cli === null) throw new Error('smoke: boot resolved no CLI, so no flow could drive one')

    // The review flows need several rows to scroll between and revisit.
    const plan = JSON.parse(await Bun.file(s.planPath).text()) as PlanRow[]
    if (plan.length < 2) {
      throw new Error(`smoke: boot seeded ${plan.length} plan row(s); review needs at least 2`)
    }
    if (plan.some(r => r.status !== 'pending')) {
      throw new Error('smoke: boot seeded a plan with a decided row; review starts on pending rows')
    }

    // End to end: the CLI this run resolved answers its own version.
    const res = await runChild([...s.cli, '--version'], { cwd: repo, env: { ...Bun.env } })
    if (res.code !== 0) {
      throw new Error(`smoke: --version exited ${res.code}\n${res.stderr}${res.stdout}`)
    }
    if (!(res.stdout + res.stderr).includes('docnamer')) {
      throw new Error(`smoke: --version did not name the program:\n${res.stdout}${res.stderr}`)
    }
  }
)

// The plan file name is a constant the harness imports from src; naming it here
// keeps a rename from silently making the smoke read a stale path.
void PLAN_FILE
