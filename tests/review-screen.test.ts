/**
 * The review screen is where a person decides row by row, so it has to say
 * where they are: a plan index like [3] leaves them unable to tell how much is
 * left. Driven as a real subprocess with a pipe, because that is how the screen
 * is reached, and against a written plan file, so no model is called.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChild } from './child.ts'
import { repo, resolveCli } from './doc-renamer-apply-harness.ts'

/** A plan row as the plan file stores it; only review's own fields matter. */
function row(old: string, flags: string[], status: string): Record<string, unknown> {
  return {
    old,
    new: `2024-03-12 ${old}`,
    type: 'receipt',
    method: 'text',
    fields: { date: '2024-03-12' },
    evidence: { date: 'Date 12 March 2024' },
    flags,
    summary: `A receipt named ${old}.`,
    size: 10,
    mtime: 0,
    status
  }
}

async function cliAsTyping(
  home: string,
  input: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = await resolveCli()
  if (argv === null) {
    throw new Error('no docnamer reachable: set DOCNAMER_BIN, or build one with `bun run build`')
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  delete env.FIREWORKS_API_KEY
  // Both stores resolve under HOME; an inherited XDG_CONFIG_HOME would point
  // docnamer's own store at the real one and make this machine-dependent.
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  return runChild([...argv, ...args], { cwd: repo, env, input })
}

test('review numbers each row by its place in the review, not by its plan index', async () => {
  const home = mkdtempSync(join(tmpdir(), 'docnamer-review-home-'))
  const folder = mkdtempSync(join(tmpdir(), 'docnamer-review-'))
  // The unflagged row is first in the plan and last to be reviewed (I3), so the
  // two orders differ and a plan index cannot be mistaken for a position.
  const rows = [
    row('a-receipt.pdf', [], 'pending'),
    row('b-receipt.pdf', ['missing required field vendor'], 'pending'),
    row('c-receipt.pdf', ['missing required field total'], 'pending')
  ]
  await Bun.write(join(folder, '.docnamer-plan.json'), JSON.stringify(rows, null, 2))

  // Three accepts, then quit.
  const run = await cliAsTyping(home, '\r\r\rq', 'review', folder)
  expect(run.code, `review exited ${run.code}: ${run.stderr}`).toBe(0)

  expect(run.stdout, 'the first row reviewed is the first flagged one').toContain('[1/3]')
  expect(run.stdout).toContain('[2/3]')
  expect(run.stdout).toContain('[3/3]')
  expect(run.stdout, 'a bare plan index is not a position').not.toContain('[1]')

  const after: { status: string }[] = JSON.parse(
    await Bun.file(join(folder, '.docnamer-plan.json')).text()
  )
  expect(after.map(r => r.status)).toEqual(['accepted', 'accepted', 'accepted'])
})
