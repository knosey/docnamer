import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { BUILD_MS, artifactsAt } from "./app-binary.ts"
import { runChild } from "./child.ts"
import { scratch } from "./scratch.ts"

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
 * The test reaches the work through the built artifact, never through a top-of-file
 * import, so a missing bundle or a degraded signature is a failed check this suite
 * prints — not an uncaught throw while the file loads.
 */

const repo = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")
/**
 * This file's own install root, handed to the build as DOCNAMER_APP_HOME so the
 * run installs into a temp folder and never over the operator's
 * ~/Applications/docnamer.app — see tests/app-binary.ts.
 */
const root = scratch("docnamer-bundle")
const at = artifactsAt(root)
const appPath = at.appDir
const appBinary = at.appBin
const infoPlist = at.appPlist

/** Read one key out of an Info.plist, XML or binary, the way macOS does. */
function plistValue(key: string): string {
  const proc = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", infoPlist])
  return proc.stdout.toString().trim()
}

test(
  "bun run build assembles ~/Applications/docnamer.app around the compiled binary",
  async () => {
    const build = await runChild(["bun", "run", "build"], {
      cwd: repo,
      env: { ...Bun.env, DOCNAMER_APP_HOME: root },
      timeoutMs: BUILD_MS
    })
    const buildOutput = `${build.stdout}${build.stderr}`
    expect(build.code, `bun run build failed:\n${buildOutput}`).toBe(0)

    expect(existsSync(appPath), `${appPath} was not created by bun run build`).toBe(true)
    expect(existsSync(infoPlist), `${infoPlist} is missing`).toBe(true)
    expect(existsSync(appBinary), `${appBinary} is missing`).toBe(true)
    const mode = statSync(appBinary).mode
    expect(
      mode & 0o111,
      `${appBinary} exists but is not executable (mode ${(mode & 0o777).toString(8)})`
    ).toBeGreaterThan(0)

    expect(plistValue("CFBundleIdentifier"), "the bundle identifier").toBe("com.tom.docnamer")
    expect(plistValue("CFBundleName"), "the display name").toBe("docnamer")
  },
  BUILD_MS
)

test("the app bundle is signed, ad-hoc or with a real identity", () => {
  expect(existsSync(appPath), `${appPath} does not exist, so there is nothing to sign`).toBe(true)

  const verify = Bun.spawnSync(["codesign", "-dv", "--verbose=2", appPath])
  const signText = `${verify.stdout.toString()}${verify.stderr.toString()}`
  expect(verify.exitCode, `codesign -dv found no signature:\n${signText}`).toBe(0)

  const identities = Bun.spawnSync(["security", "find-identity", "-v", "-p", "codesigning"])
  const identityText = `${identities.stdout.toString()}${identities.stderr.toString()}`
  const hasRealIdentity = /\)\s+[0-9A-F]{40}\s+"/.test(identityText)

  if (hasRealIdentity) {
    expect(signText, "a real identity exists, so the bundle must carry it").toMatch(/Authority=/)
  } else {
    expect(signText, "no identity exists, so the bundle must be signed ad-hoc").toMatch(
      /Signature=adhoc/
    )
  }
})

/** The four folder kinds docnamer reads, each of which TCC gates on its own key. */
const folderUsageKeys = [
  "NSDesktopFolderUsageDescription",
  "NSDocumentsFolderUsageDescription",
  "NSDownloadsFolderUsageDescription",
  "NSRemovableVolumesUsageDescription"
]

test("the bundle is a background agent that declares the folders it reads", () => {
  expect(existsSync(infoPlist), `${infoPlist} is missing`).toBe(true)

  expect(plistValue("LSUIElement"), "LSUIElement keeps the agent out of the Dock").toBe("true")

  const absent = folderUsageKeys.filter(key => plistValue(key) === "")
  expect(absent, `Info.plist declares no usage description for: ${absent.join(", ")}`).toEqual([])
})
