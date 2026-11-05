// The hook gates what lands. A commit that only deletes files changes the tree
// as much as one that adds them — a deleted module, a deleted import — so the
// gates run for it too. `bun` and `bunx` are stubs here: this asserts which
// gates the hook invokes, not what they find.
import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = await mkdtemp(join(tmpdir(), "docnamer-hook-"))
const stubs = join(dir, "stubs")
// A hook inherits GIT_DIR and GIT_INDEX_FILE from the commit that fired it; left
// in place they point every git call below at the outer repo's index.
const env: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
)
env.PATH = `${stubs}:${process.env.PATH}`

afterAll(() => rm(dir, { recursive: true, force: true }))

async function git(args: string[], overrides: Record<string, string | undefined> = {}) {
  const run = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe"
  })
  const code = await run.exited
  const err = await new Response(run.stderr).text()
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
}

/** Commit with the hook watching, and answer the gates it invoked. */
async function gatesOf(message: string) {
  const log = join(dir, `${message}.log`)
  await git(["commit", "-q", "-m", message], { GATES_LOG: log })
  return (await readFile(log, "utf8")).split("\n").filter(Boolean)
}

test("a commit that only deletes files runs the same gates as one that adds them", async () => {
  await mkdir(join(dir, ".githooks"), { recursive: true })
  await mkdir(stubs)
  await writeFile(
    join(dir, ".githooks", "pre-commit"),
    await readFile(join(import.meta.dir, "..", ".githooks", "pre-commit"))
  )
  await chmod(join(dir, ".githooks", "pre-commit"), 0o755)
  for (const name of ["bun", "bunx"]) {
    await writeFile(
      join(stubs, name),
      `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> "$GATES_LOG"\n`
    )
    await chmod(join(stubs, name), 0o755)
  }
  await git(["init", "-q"])
  await git(["config", "core.hooksPath", ".githooks"])
  await git(["config", "user.email", "hook@docnamer.test"])
  await git(["config", "user.name", "hook"])

  await writeFile(join(dir, "a.txt"), "one\n")
  await git(["add", "a.txt"])
  const added = await gatesOf("add")

  await git(["rm", "-q", "a.txt"])
  const removed = await gatesOf("remove")

  expect(added.length).toBeGreaterThan(0)
  expect(removed).toEqual(added)
})
