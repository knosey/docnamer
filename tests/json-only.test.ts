// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`ls tests/fixtures`

import { expect, test } from 'bun:test'
import { repo, resolveCli } from './doc-renamer-apply-harness.ts'
import { BUILTIN_CONFIG } from '../src/config.ts'
import { evalTestset } from '../src/eval.ts'

/**
 * T7 — the eval truth file is JSON, and the test set carries no YAML at all.
 *
 * The truth `evalTestset` scores against was `tests/testset/expected.yaml`, read
 * through `Bun.YAML.parse`. That made YAML the one non-JSON format the repo
 * spoke, for a file whose whole content is a map of string to string. It is now
 * `expected.json`, read through `JSON.parse`, and this file is what makes the
 * old shape impossible to come back to.
 *
 * The check that matters most is the last one: a truth file that is NOT JSON must
 * be REFUSED, never scored. `Bun.YAML.parse` accepted the YAML body and a parser
 * that fails soft would score zero files and report zero misses — a green run
 * over a test set it never read. So the old YAML body is fed to `evalTestset` and
 * the call must throw.
 *
 * Every case here is free: the graded set is only ever READ, and a test set with
 * a missing or unparseable truth file throws before `plan()` is reached, so no
 * model is called. The last case drives the real CLI through the resolver the
 * apply harness owns, and `eval --help` answers before any folder is opened.
 */

const TESTSET = `${repo}/tests/testset`
const TRUTH = `${TESTSET}/expected.json`

/** The graded files, from the reference command — never from the test set itself,
 *  so a truth file that drifts from the fixtures cannot satisfy this. */
function fixtureNames(): string[] {
  const proc = Bun.spawnSync(reference.split(/\s+/).filter(Boolean), { cwd: repo })
  const out = proc.stdout.toString().trim()
  expect(out.length, 'the reference command listed no fixtures to compare against').toBeGreaterThan(
    0
  )
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort()
}

/** A throwaway folder for the failure cases — nothing is ever written into the repo. */
async function scratch(body?: string): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-json-${crypto.randomUUID()}`
  if (body !== undefined) await Bun.write(`${dir}/expected.json`, body)
  return dir
}

test('the truth file is tests/testset/expected.json and names exactly the graded fixtures', async () => {
  expect(await Bun.file(TRUTH).exists(), `${TRUTH} is missing: the truth file must be JSON`).toBe(
    true
  )
  const parsed = JSON.parse(await Bun.file(TRUTH).text()) as Record<string, unknown>
  expect(
    Object.keys(parsed).sort(),
    'the JSON truth file does not name the same files as the reference fixture listing'
  ).toEqual(fixtureNames())
})

test('the test set carries no YAML: the truth file is JSON and nothing else parses as one', async () => {
  const yaml: string[] = []
  for await (const rel of new Bun.Glob('**/*.{yaml,yml}').scan({ cwd: TESTSET })) yaml.push(rel)
  expect(yaml, 'the test set still carries YAML; the truth file is expected.json').toEqual([])
})

test('evalTestset refuses a test set with no expected.json, and names the file it wants', async () => {
  const dir = await scratch()
  await expect(evalTestset(dir, BUILTIN_CONFIG)).rejects.toThrow('expected.json')
})

test('evalTestset refuses a truth file that is not JSON, rather than scoring it as empty', async () => {
  // The exact body the old expected.yaml carried. JSON.parse rejects it, and a
  // soft parser would have scored zero files and reported zero misses. The
  // rejection must be the PARSER's — a SyntaxError — and not the missing-file
  // error above, which is why the file is written and a plain `Error` would fail
  // this check.
  const dir = await scratch('# the truth\ndup-invoice.md:\n  type: invoice\n')
  await expect(evalTestset(dir, BUILTIN_CONFIG)).rejects.toThrow(SyntaxError)
})

test('eval --help points at the JSON truth file, not the YAML one it used to read', async () => {
  const argv = await resolveCli()
  if (argv === null) {
    throw new Error('no docnamer reachable: set DOCNAMER_BIN, or build one with `bun run build`')
  }
  const p = Bun.spawn([...argv, 'eval', '--help'], { stdout: 'pipe', stderr: 'pipe', cwd: repo })
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  expect(code, `eval --help exited ${code}`).toBe(0)
  expect(stdout, 'eval --help does not name the truth file it reads').toContain('expected.json')
})
