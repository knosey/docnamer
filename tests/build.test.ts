// The reference the graph runner swaps through GRAPH_REFERENCE; assert against it, never edit it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun --version`

import { beforeAll, expect, test } from "bun:test"
import { copyFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { BUILD_MS, artifactsAt } from "./app-binary.ts"
import { runChild } from "./child.ts"
import { ensureProviderKey, MODEL_CALL_MS } from "./preload.ts"
import { scratch } from "./scratch.ts"

/**
 * `package.json` (the `build`/`install` scripts) and `src/read.ts` (`macOcrBinary()` reaching the
 * mac-ocr copy embedded in the binary) are reached through the built artifact and the reference
 * command, never through a top-of-file import, so a missing script, a missing binary or a degraded
 * plan is a failed check this suite reports — not a throw at load.
 *
 * `bun --version` prints the version the compiled binary must reproduce under `BUN_BE_BUN=1`, which
 * makes a compiled Bun binary answer as Bun itself; it is the truth this build is measured against.
 *
 * The build installs into a root of this file's own, handed over as DOCNAMER_APP_HOME. A test that
 * ran `bun run build` against the real ~/Applications/docnamer.app would install a build of
 * whatever branch it ran on as the tool on the machine — see tests/app-binary.ts. The wrapper
 * resolves its tty with `tty` and refuses without one, so a non-pty flow can only ever drive the
 * binary; tests/wrapper-pty.test.ts drives the installed wrapper itself, on a real pty.
 *
 * The last test makes a REAL paid model call, which is why this file is not in the `test:free` set
 * `bun run test:free` and the pre-commit hook run. tests/app-bundle.test.ts carries the checks on
 * the built artifact that need no model.
 */

const repo = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")

/** This file's own install root. */
const root = scratch("docnamer-build")
const at = artifactsAt(root)

/** Run the reference command and return what it prints — the truth. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(reference.split(/\s+/).filter(Boolean))
  return proc.stdout.toString().trim()
}

/** Build once, into `root`, before anything asserts on the artifact. */
beforeAll(async () => {
  const build = await runChild(["bun", "run", "build"], {
    cwd: repo,
    env: { ...Bun.env, DOCNAMER_APP_HOME: root },
    timeoutMs: BUILD_MS
  })
  expect(build.code, `bun run build failed:\n${build.stdout}${build.stderr}`).toBe(0)
})

test("bun run build installs an executable wrapper beside the app", () => {
  expect(existsSync(at.wrapper), `${at.wrapper} was not created by bun run build`).toBe(true)
  const mode = statSync(at.wrapper).mode
  expect(
    mode & 0o111,
    `${at.wrapper} exists but is not executable (mode ${(mode & 0o777).toString(8)})`
  ).toBeGreaterThan(0)
})

test("BUN_BE_BUN=1 the app binary --version prints what the reference prints", () => {
  expect(existsSync(at.appBin), `${at.appBin} does not exist, so there is nothing to run`).toBe(
    true
  )
  const proc = Bun.spawnSync([at.appBin, "--version"], { env: { ...Bun.env, BUN_BE_BUN: "1" } })
  expect(proc.exitCode, `--version failed:\n${proc.stderr.toString()}`).toBe(0)
  expect(proc.stdout.toString().trim()).toBe(referenceOutput())
})

test(
  "the compiled binary plans a scan PDF as itself, not degraded to other",
  async () => {
    // A spawned child does NOT inherit `Bun.env` mutations made after startup.
    // Verified on bun 1.4.3: `ensureProviderKey()` sets both `Bun.env` and
    // `process.env`, and a child spawned with no `env` option still sees neither,
    // because the default is a snapshot taken when the process started. So the key
    // has to be handed over explicitly, and asking for it here is what makes
    // `bun test tests/build.test.ts` on its own a real check.
    await ensureProviderKey()
    expect(existsSync(at.appBin), `${at.appBin} does not exist, so there is nothing to run`).toBe(
      true
    )
    const dir = scratch("docnamer-plan")
    copyFileSync(
      join(repo, "tests/fixtures/acme-statement-scan.pdf"),
      join(dir, "acme-statement-scan.pdf")
    )
    // No docnamer.json is copied in, on purpose: the binary must carry its own
    // roster to a bare folder, which is the whole point of shipping one file.

    // cwd is the bare folder, not the repo: with cwd=repo the checkout's own
    // docnamer.json is one relative path away, so a binary that read its config
    // off disk would pass here without carrying one at all. From the bare folder
    // there is nothing to read, and only an inlined roster can produce a type.
    const proc = Bun.spawnSync([at.appBin, "plan", dir], {
      cwd: dir,
      env: { ...Bun.env },
      timeout: MODEL_CALL_MS,
      killSignal: "SIGTERM"
    })
    expect(proc.exitCode, `plan failed:\n${proc.stderr.toString()}`).toBe(0)

    const planPath = join(dir, ".docnamer-plan.json")
    expect(existsSync(planPath), `${planPath} was not written`).toBe(true)
    const parsed = JSON.parse(await Bun.file(planPath).text())
    const rows = Array.isArray(parsed) ? parsed : parsed.rows
    expect(rows.length, "the folder holds exactly one document").toBe(1)
    expect(rows[0].type, "a scan must not degrade to other").not.toBe("other")
    const macOcrFlags = rows[0].flags.filter((f: string) => f.includes("mac-ocr"))
    expect(macOcrFlags, "a compiled binary must reach the embedded mac-ocr").toEqual([])
    Bun.spawnSync(["rm", "-rf", dir])
  },
  // `plan` on a scan PDF makes a real model call, and the default 5s budget sits
  // below the call it waits on — measured at 2.9s idle, past 5s under the load of
  // the rest of the suite.
  MODEL_CALL_MS
)
