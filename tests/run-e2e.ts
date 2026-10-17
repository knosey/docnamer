/**
 * `test:e2e` runner. `bun run test:e2e` runs every tests/**\/*.spec.ts; with file
 * arguments it runs exactly those files (`bun run test:e2e tests/foo.spec.ts`).
 *
 * Spec files receive a global `flow(name, fn)`: `fn` resolves to pass, throws to
 * fail, or throws a `Skipped` (carrying `skip === true`) to report a named hole
 * without going green. The runner exits non-zero only on a real failure.
 */

let failed = 0
let skipped = 0

/**
 * Every `flow()` the specs start, held until it settles.
 *
 * A spec calls `flow(name, fn)` without awaiting it, so its `import` resolves
 * while the flow is still pending. Exiting there reported success for tests
 * that never ran: run ship-feature-f3bae4's four specs each exited 0 with no
 * flow finished, every flow test was "GREEN BEFORE THE BUILD", and the run died
 * three children later. The runner holds each promise and settles them all
 * before it reports. `flow` returns its promise as well, so a spec may await it.
 */
const pending: Promise<void>[] = []

const report = async (name: string, fn: unknown): Promise<void> => {
  if (typeof fn !== 'function') {
    if (fn) console.info('FLOW PASSED: ' + name)
    else {
      console.error('FLOW FAILED: ' + name)
      failed++
    }
    return
  }
  try {
    await (fn as () => unknown)()
    console.info('FLOW PASSED: ' + name)
  } catch (e) {
    const err = e as { skip?: boolean; claim?: string; stack?: string }
    if (err && err.skip === true) {
      console.info('FLOW SKIPPED: ' + name + ' — ' + (err.claim ?? 'unobservable'))
      skipped++
      return
    }
    console.error('FLOW FAILED: ' + name + ': ' + (err?.stack ?? e))
    failed++
  }
}

;(globalThis as unknown as { flow: unknown }).flow = (name: string, fn: unknown): Promise<void> => {
  const p = report(name, fn)
  pending.push(p)
  return p
}

const repo = import.meta.dir.replace(/\/tests$/, '')

/**
 * The red control (tests-red.ts CONTROL_MARK) asserts something false and must
 * fail, so discovery leaves it out — a whole-suite run is not red forever.
 * `harness-smoke` runs it by name, and arguments are run as given.
 */
const CONTROL = '-harness.red.'

async function discover(): Promise<string[]> {
  const out: string[] = []
  for await (const rel of new Bun.Glob('**/*.spec.ts').scan({ cwd: `${repo}/tests` })) {
    if (rel.includes(CONTROL)) continue
    out.push(`${repo}/tests/${rel}`)
  }
  return out.sort()
}

function abs(f: string): string {
  return f.startsWith('/') ? f : `${process.cwd()}/${f}`
}

const args = process.argv.slice(2)
const files = args.length ? args.map(abs) : await discover()
for (const f of files) {
  try {
    await import(f)
  } catch (e) {
    console.error('SPEC FAILED TO LOAD: ' + f + ': ' + ((e as Error)?.stack ?? e))
    failed++
  }
}
await Promise.all(pending)
if (pending.length === 0) {
  console.error(
    'NO FLOW RAN: ' +
      files.length +
      ' spec file(s) loaded and not one called flow(), so this run observed nothing'
  )
  failed++
}

console.info(`\n${failed} failed, ${skipped} skipped, ${files.length} spec file(s)`)
process.exit(failed ? 1 : 0)
