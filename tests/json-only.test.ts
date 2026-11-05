import { expect, test } from "bun:test"
import { runChild } from "./child.ts"
import { repo, resolveCli } from "./doc-renamer-apply-harness.ts"
import { BUILTIN_CONFIG } from "../src/config.ts"
import { evalTestset } from "../src/eval.ts"
import { scratch } from "./scratch.ts"

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

/** A throwaway folder for the failure cases — nothing is ever written into the repo. */
async function truthset(body?: string): Promise<string> {
  const dir = scratch("docnamer-json")
  if (body !== undefined) await Bun.write(`${dir}/expected.json`, body)
  return dir
}

test("evalTestset refuses a test set with no expected.json, and names the file it wants", async () => {
  const dir = await truthset()
  await expect(evalTestset(dir, BUILTIN_CONFIG)).rejects.toThrow("expected.json")
})

test("evalTestset refuses a truth file that is not JSON, rather than scoring it as empty", async () => {
  // The exact body the old expected.yaml carried. JSON.parse rejects it, and a
  // soft parser would have scored zero files and reported zero misses. The
  // rejection must be the PARSER's — a SyntaxError — and not the missing-file
  // error above, which is why the file is written and a plain `Error` would fail
  // this check.
  const dir = await truthset("# the truth\ndup-invoice.md:\n  type: invoice\n")
  await expect(evalTestset(dir, BUILTIN_CONFIG)).rejects.toThrow(SyntaxError)
})

test("eval --help points at the JSON truth file", async () => {
  const argv = await resolveCli()
  if (argv === null) {
    throw new Error("no docnamer reachable: set DOCNAMER_BIN, or build one with `bun run build`")
  }
  const r = await runChild([...argv, "eval", "--help"], { cwd: repo })
  expect(r.code, `eval --help exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, "eval --help does not name the truth file it reads").toContain("expected.json")
})
