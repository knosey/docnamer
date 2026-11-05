// The hook gates what lands. A commit that only deletes files changes the tree
// as much as one that adds them — a deleted module, a deleted import — so the
// gates run for it too. `bun` and `bunx` are stubs here: this asserts which
// gates the hook invokes, not what they find.
import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dir = await mkdtemp(join(tmpdir(), "docnamer-hook-"))
const log = join(dir, "gates.log")
const stubs = join(dir, "stubs")
// A hook inherits GIT_DIR and GIT_INDEX_FILE from the commit that fired it; left
// in place they point every git call below at the outer repo's index.
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
)

afterAll(() => rm(dir, { recursive: true, force: true }))

async function git(args: string[], env: Record<string, string | undefined> = clean) {
  const run = Bun.spawn(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
  const code = await run.exited
  const err = await new Response(run.stderr).text()
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
}

test("a commit that only deletes files runs the same gates as one that adds them", async () => {
  await mkdir(join(dir, ".githooks"), { recursive: true })
  await mkdir(stubs)
  await writeFile(
    join(dir, ".githooks", "pre-commit"),
    await readFile(join(root, ".githooks", "pre-commit"))
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
  const env = { ...clean, PATH: `${stubs}:${process.env.PATH}`, GATES_LOG: log }
  const commit = (message: string) =>
    git(
      [
        "-c",
        "user.email=hook@docnamer.test",
        "-c",
        "user.name=hook",
        "commit",
        "-q",
        "-m",
        message
      ],
      env
    )

  await writeFile(join(dir, "a.txt"), "one\n")
  await git(["add", "a.txt"])
  await commit("add")
  const added = (await readFile(log, "utf8")).split("\n").filter(Boolean)

  await writeFile(log, "--boundary--\n")
  await git(["rm", "-q", "a.txt"])
  await commit("remove")
  const removed = (await readFile(log, "utf8"))
    .split("--boundary--\n")[1]
    .split("\n")
    .filter(Boolean)

  expect(added.length).toBeGreaterThan(0)
  expect(removed).toEqual(added)
})
