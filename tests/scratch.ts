// Scratch directories that remove themselves. A script that makes one calls
// `cleanupScratch` in a `finally`; a test file that makes one needs nothing, the
// exit hook below covers it. Without this, /tmp fills with credential files that
// look real and are never read again — one run's homes were 30 directories deep.

import { mkdirSync, rmSync } from "node:fs"

const made: string[] = []

/** A unique scratch directory under TMPDIR, created, removed by `cleanupScratch`.
 *  It exists on return: every caller wants to write into it, and one that had to
 *  mkdir first could forget, and then fail somewhere further away. */
export function scratch(prefix: string): string {
  const dir = `${Bun.env.TMPDIR ?? "/tmp"}/${prefix}-${crypto.randomUUID()}`
  mkdirSync(dir, { recursive: true })
  made.push(dir)
  return dir
}

/** Remove every directory `scratch` handed out. Safe to call more than once. */
export function cleanupScratch(): void {
  // The removal must not depend on a test file remembering an `afterAll`: a spec
  // that throws before its teardown is exactly the run that leaves the most behind.
  while (made.length > 0) {
    const dir = made.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
}

// One exit hook per PROCESS, not per module load: the runner may load this file
// once for each test file, and a listener each would trip the 10-listener limit.
// The key is on globalThis, which survives those reloads.
const HOOK = Symbol.for("docnamer.scratch.exitHook")
if (!Object.hasOwn(globalThis, HOOK)) {
  Object.defineProperty(globalThis, HOOK, { value: true })
  process.on("exit", cleanupScratch)
}
