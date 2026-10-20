// Scratch directories that remove themselves. Every test file that makes one
// registers the cleanup once (`afterAll(cleanupScratch)`); a script that makes
// one calls it in a `finally`. Without this, /tmp fills with credential files
// that look real and are never read again.

import { rmSync } from 'node:fs'

const made: string[] = []

/** A unique scratch directory under TMPDIR, removed by `cleanupScratch`. */
export function scratch(prefix: string): string {
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/${prefix}-${crypto.randomUUID()}`
  made.push(dir)
  return dir
}

/** Remove every directory `scratch` handed out. Safe to call more than once. */
export function cleanupScratch(): void {
  while (made.length > 0) {
    const dir = made.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
}
