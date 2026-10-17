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
 *
 * The second flow covers the same outcome on a row Stage 2 could NOT analyse.
 * I3 is unconditional — no row may ever propose a name already on disk — and
 * the first flow reaches that path only when the model returns an unparseable
 * reply, which is nondeterministic: the earlier claim that this happened in
 * "2 of 8 runs" against the 12x12 unreadable-scan.pdf fixture did NOT
 * reproduce (0 of 8, measured twice, text and vision). A flaky reach is not a
 * tested path, so the second flow makes the failure deterministic without
 * faking a model: the folder's config names model refs that resolve to nothing
 * in the catalog.
 */
import {
  Session,
  boot,
  entry,
  render,
  collide,
  suffix,
  outcome,
  repo,
  CONFIG_FILE
} from './doc-renamer-pipeline-harness.ts'

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

flow('doc-renamer-pipeline I3: a failed analysis still proposes a free name', async () => {
  const s = new Session()
  const unknown = 'no-such-provider/no-such-model'

  // Boot first, so the folder's config can be replaced BEFORE plan runs:
  // entry() boots and plans in one step, and boot() returns early once booted.
  await boot(s)

  const rewritten = (await Bun.file(`${repo}/${CONFIG_FILE}`).text())
    .replace(/^(\s*cheap:\s*).*$/m, `$1${unknown}`)
    .replace(/^(\s*vision:\s*).*$/m, `$1${unknown}`)
    .replace(/^(\s*strong:\s*).*$/m, `$1${unknown}`)

  // Guard the guard. If the config's shape ever moves, the rewrite does nothing,
  // this flow silently runs against the real models, and it passes for the wrong
  // reason. Count the substitutions rather than trusting them.
  const swapped = rewritten.split(unknown).length - 1
  if (swapped !== 3) {
    throw new Error(
      `I3 failed-analysis: expected 3 model refs replaced in ${CONFIG_FILE}, replaced ${swapped}`
    )
  }
  await Bun.write(`${s.dir}/${CONFIG_FILE}`, rewritten)

  await entry(s)

  if (!s.plan.length) {
    throw new Error('I3 failed-analysis: the plan has no rows, so nothing was observed')
  }

  // Every row must have failed BEFORE any model call. An unresolvable ref is
  // refused by resolveModel() (src/analyse.ts), so the flag names the model ref
  // rather than a reply. That is also the proof no model was called, and so
  // that the config rewrite took effect.
  for (const r of s.plan) {
    const failure = r.flags.find(f => f.startsWith('analysis failed:'))
    if (!failure) {
      throw new Error(
        `I3 failed-analysis: ${r.old} carried no failure flag, so the unresolvable ` +
          `model refs never reached analyse(): ${JSON.stringify(r.flags)}`
      )
    }
    if (!failure.includes('unknown model')) {
      throw new Error(
        `I3 failed-analysis: ${r.old} failed on something other than the model ref ` +
          `("${failure}"), so a real model was called and this flow no longer isolates ` +
          'the failed-analysis path'
      )
    }
  }

  // I3's outcome, on the rows nothing could analyse.
  const onDisk = new Set([...s.originals.keys()].map(n => n.toLowerCase()))
  const seen = new Map<string, string>()
  for (const r of s.plan) {
    if (!r.new) throw new Error(`I3 failed-analysis: ${r.old} proposes no name`)
    if (/[/\\:*?"<>|]/.test(r.new)) {
      throw new Error(`I3 failed-analysis: name not sanitised: ${r.new}`)
    }
    if (onDisk.has(r.new.toLowerCase())) {
      throw new Error(`I3 failed-analysis: ${r.old} proposes a name already on disk: ${r.new}`)
    }
    const prev = seen.get(r.new.toLowerCase())
    if (prev) {
      throw new Error(`I3 failed-analysis: ${r.old} and ${prev} both propose ${r.new}`)
    }
    seen.set(r.new.toLowerCase(), r.old)
  }
})
