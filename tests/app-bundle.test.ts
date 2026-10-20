// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? "grep -rn node: src/"

import { expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * S3 — Ship docnamer as its own macOS app: the bundle, its signing, and the
 * node:-built-in ban.
 *
 * The work under test is `scripts/build-app.ts` and `package.json` (the `build`
 * script): `bun run build` must compile the binary and assemble
 * `~/Applications/docnamer.app` — Info.plist with CFBundleIdentifier
 * com.tom.docnamer and CFBundleName docnamer, the executable in Contents/MacOS —
 * and sign it ad-hoc, or with a real identity when `security find-identity`
 * yields one.
 *
 * The reference `grep -rn node: src/` is the truth the ban is measured against:
 * every occurrence it reports in a shipped source must be a mention, never an
 * import.
 *
 * The test reaches the work through the built artifact and the reference command,
 * never through a top-of-file import, so a missing script, a missing bundle or a
 * degraded signature is a failed check this suite prints — not an uncaught throw
 * while the file loads.
 */

const repo = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
const home = Bun.env.HOME ?? ''
const buildScript = join(repo, 'scripts', 'build-app.ts')
const appPath = join(home, 'Applications', 'docnamer.app')
const infoPlist = join(appPath, 'Contents', 'Info.plist')
const appBinary = join(appPath, 'Contents', 'MacOS', 'docnamer')

/** Run the reference command and return what it prints — the truth. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(['/bin/sh', '-c', reference], { cwd: repo })
  return proc.stdout.toString()
}

/** Read one key out of an Info.plist, XML or binary, the way macOS does. */
function plistValue(key: string): string {
  const proc = Bun.spawnSync(['plutil', '-extract', key, 'raw', '-o', '-', infoPlist])
  return proc.stdout.toString().trim()
}

/** An actual import of a node: built-in, as opposed to a comment that mentions one. */
const NODE_IMPORT = /(?:from|import)\s*\(?\s*['"]node:|require\s*\(\s*['"]node:/

test('the shipped sources import no node: built-ins (the reference is the scan)', () => {
  const reported = referenceOutput()
  const offenders = reported.split('\n').filter(line => NODE_IMPORT.test(line))
  expect(
    offenders,
    `node: built-ins reach the shipped sources:\n${offenders.join('\n')}`
  ).toEqual([])
})

test('the build script exists', () => {
  expect(existsSync(buildScript), `${buildScript} does not exist`).toBe(true)
})

test('bun run build assembles ~/Applications/docnamer.app around the compiled binary', () => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: repo })
  const buildOutput = `${build.stdout.toString()}${build.stderr.toString()}`
  expect(build.exitCode, `bun run build failed:\n${buildOutput}`).toBe(0)

  expect(existsSync(appPath), `${appPath} was not created by bun run build`).toBe(true)
  expect(existsSync(infoPlist), `${infoPlist} is missing`).toBe(true)
  expect(existsSync(appBinary), `${appBinary} is missing`).toBe(true)
  const mode = statSync(appBinary).mode
  expect(
    mode & 0o111,
    `${appBinary} exists but is not executable (mode ${(mode & 0o777).toString(8)})`
  ).toBeGreaterThan(0)

  expect(plistValue('CFBundleIdentifier'), 'the bundle identifier').toBe('com.tom.docnamer')
  expect(plistValue('CFBundleName'), 'the display name').toBe('docnamer')
})

test('the app bundle is signed, ad-hoc or with a real identity', () => {
  expect(existsSync(appPath), `${appPath} does not exist, so there is nothing to sign`).toBe(true)

  const verify = Bun.spawnSync(['codesign', '-dv', '--verbose=2', appPath])
  const signText = `${verify.stdout.toString()}${verify.stderr.toString()}`
  expect(verify.exitCode, `codesign -dv found no signature:\n${signText}`).toBe(0)

  const identities = Bun.spawnSync(['security', 'find-identity', '-v', '-p', 'codesigning'])
  const identityText = `${identities.stdout.toString()}${identities.stderr.toString()}`
  const hasRealIdentity = /\)\s+[0-9A-F]{40}\s+"/.test(identityText)

  if (hasRealIdentity) {
    expect(signText, 'a real identity exists, so the bundle must carry it').toMatch(/Authority=/)
  } else {
    expect(signText, 'no identity exists, so the bundle must be signed ad-hoc').toMatch(
      /Signature=adhoc/
    )
  }
})
