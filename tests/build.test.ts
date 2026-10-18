// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun --version`

import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProviderKey } from './preload.ts'

/**
 * T5 — Compile to one standalone binary and install it (R1).
 *
 * `package.json` (the `build`/`install` scripts) and `src/read.ts`
 * (`macOcrBinary()` reaching the mac-ocr copy embedded in the binary) are the
 * work under test. The test reaches that work through the built artifact and
 * the reference command, never through a top-of-file import, so a missing
 * script, a missing binary or a degraded plan is a failed check this suite
 * reports — not an uncaught throw while the file loads.
 *
 * The reference `bun --version` prints the version the compiled binary must
 * reproduce under `BUN_BE_BUN=1`, which makes a compiled Bun binary answer as
 * Bun itself; it is the truth this build is measured against.
 */

const repo = new URL('..', import.meta.url).pathname.replace(/\/+$/, '')
const home = Bun.env.HOME ?? ''
const binPath = join(home, 'bin', 'docnamer')

/** Run the reference command and return what it prints — the truth. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(reference.split(/\s+/).filter(Boolean))
  return proc.stdout.toString().trim()
}

test('bun run build exits 0 and installs an executable ~/bin/docnamer', () => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: repo })
  expect(
    build.exitCode,
    `bun run build failed:\n${build.stdout.toString()}${build.stderr.toString()}`
  ).toBe(0)
  expect(existsSync(binPath), `${binPath} was not created by bun run build`).toBe(true)
  const mode = statSync(binPath).mode
  expect(
    mode & 0o111,
    `${binPath} exists but is not executable (mode ${(mode & 0o777).toString(8)})`
  ).toBeGreaterThan(0)
})

test('BUN_BE_BUN=1 ~/bin/docnamer --version prints what the reference prints', () => {
  expect(existsSync(binPath), `${binPath} does not exist, so there is nothing to run`).toBe(true)
  const proc = Bun.spawnSync([binPath, '--version'], { env: { ...Bun.env, BUN_BE_BUN: '1' } })
  expect(proc.exitCode, `--version failed:\n${proc.stderr.toString()}`).toBe(0)
  expect(proc.stdout.toString().trim()).toBe(referenceOutput())
})

test('no node: built-ins are imported anywhere in src/ (R1, D2)', async () => {
  const glob = new Bun.Glob('*.ts')
  for await (const file of glob.scan(join(repo, 'src'))) {
    const src = await Bun.file(join(repo, 'src', file)).text()
    expect(
      /from\s+['"]node:|require\(['"]node:/.test(src),
      `src/${file} imports a node: built-in; the standalone binary must stay native Bun + platform frameworks`
    ).toBe(false)
  }
})

test('the compiled binary plans a scan PDF as itself, not degraded to other', async () => {
  // A spawned child does NOT inherit `Bun.env` mutations made after startup.
  // Verified on bun 1.4.2: `ensureProviderKey()` sets both `Bun.env` and
  // `process.env`, and a child spawned with no `env` option still sees neither,
  // because the default is a snapshot taken when the process started. So the key
  // has to be handed over explicitly, and asking for it here is what makes
  // `bun test tests/build.test.ts` on its own a real check.
  await ensureProviderKey()
  expect(existsSync(binPath), `${binPath} does not exist, so there is nothing to run`).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'docnamer-build-'))
  copyFileSync(
    join(repo, 'tests/fixtures/acme-statement-scan.pdf'),
    join(dir, 'acme-statement-scan.pdf')
  )
  // No docnamer.json is copied in, on purpose: the binary must carry its own
  // roster to a bare folder, which is the whole point of shipping one file.

  // cwd is the bare folder, not the repo: with cwd=repo the checkout's own
  // docnamer.json is one relative path away, so a binary that read its config
  // off disk would pass here without carrying one at all. From the bare folder
  // there is nothing to read, and only an inlined roster can produce a type.
  const proc = Bun.spawnSync([binPath, 'plan', dir], { cwd: dir, env: { ...Bun.env } })
  expect(proc.exitCode, `plan failed:\n${proc.stderr.toString()}`).toBe(0)

  const planPath = join(dir, '.docnamer-plan.json')
  expect(existsSync(planPath), `${planPath} was not written`).toBe(true)
  const parsed = JSON.parse(await Bun.file(planPath).text())
  const rows = Array.isArray(parsed) ? parsed : parsed.rows
  expect(rows.length, 'the folder holds exactly one document').toBe(1)
  expect(rows[0].type, 'a scan must not degrade to other').not.toBe('other')
  const macOcrFlags = rows[0].flags.filter((f: string) => f.includes('mac-ocr'))
  expect(macOcrFlags, 'a compiled binary must reach the embedded mac-ocr').toEqual([])
  Bun.spawnSync(['rm', '-rf', dir])
})
