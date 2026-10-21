/**
 * The review screen is where a person decides row by row, so it has to say
 * where they are: a plan index like [3] leaves them unable to tell how much is
 * left. Driven as a real subprocess with a pipe, because that is how the screen
 * is reached, and against a written plan file, so no model is called.
 */
import { expect, test } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui/dist/utils.js'
import { join } from 'node:path'
import { runCliAs } from './doc-renamer-apply-harness.ts'
import { ANSI } from './pty.ts'
import { scratch } from './scratch.ts'

// The reference the graph runner swaps through GRAPH_REFERENCE; assert against it, never edit it.
export const reference = process.env.GRAPH_REFERENCE ?? 'tput cols'

/** What the reference command prints — the terminal width the review screen must fit. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(['/bin/sh', '-c', reference], { stdout: 'pipe' })
  return new TextDecoder().decode(proc.stdout).trim()
}

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

test('review numbers each row by its place in the review, not by its plan index', async () => {
  const home = scratch('docnamer-review-home')
  const folder = scratch('docnamer-review')
  // The unflagged row is first in the plan and last to be reviewed (I3), so the
  // two orders differ and a plan index cannot be mistaken for a position.
  const rows = [
    row('a-receipt.pdf', [], 'pending'),
    row('b-receipt.pdf', ['missing required field vendor'], 'pending'),
    row('c-receipt.pdf', ['missing required field total'], 'pending')
  ]
  await Bun.write(join(folder, '.docnamer-plan.json'), JSON.stringify(rows, null, 2))

  // Three accepts, then quit.
  const run = await runCliAs(home, ['review', folder], '\r\r\rq')
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

test('review stacks padded cards inside the reference width with a locked controls header', async () => {
  const width = Number(referenceOutput())
  expect(
    Number.isFinite(width) && width > 0,
    `the reference printed no width: ${JSON.stringify(referenceOutput())}`
  ).toBe(true)

  const home = scratch('docnamer-cards-home')
  const folder = scratch('docnamer-cards')
  const rows = [
    row('a-receipt.pdf', [], 'pending'),
    row('b-receipt.pdf', ['missing required field vendor'], 'pending'),
    row('c-receipt.pdf', ['missing required field total'], 'pending')
  ]
  await Bun.write(join(folder, '.docnamer-plan.json'), JSON.stringify(rows, null, 2))

  // Move down a row, then quit — the header must survive the scroll.
  const run = await runCliAs(home, ['review', folder], '\u001b[Bq')
  expect(run.code, `review exited ${run.code}: ${run.stderr}`).toBe(0)

  // A person sees the frame without ANSI escapes.
  const plain = run.stdout.replace(ANSI, '')
  const lines = plain.split(/\r\n|\n|\r/)

  // Controls header: accept / edit / skip / quit, present in the scrolled frame.
  expect(plain, 'the controls header is missing').toMatch(/accept/i)
  expect(plain, 'the controls header lost its keys').toMatch(/quit/i)
  expect(plain, 'the controls header lost its position').toMatch(/\d+\/\d+/)

  // Stacked cards: two documents' names appear, each on its own line, and the
  // line that starts a later card is preceded by a blank padded line.
  const starts = lines.map((l, i) => (/\[\d+\/\d+\]/.test(l) ? i : -1)).filter(i => i >= 0)
  expect(starts.length, `fewer than two cards in the frame:\n${plain}`).toBeGreaterThanOrEqual(2)
  expect(lines[starts[1]! - 1] ?? '', `no padded line between stacked cards:\n${plain}`).toMatch(
    /^\s*$/
  )

  // Every visible line fits the reference width — the terminal truth.
  for (const line of lines) {
    expect(
      visibleWidth(line),
      `a card line is wider than ${width}: ${JSON.stringify(line)}`
    ).toBeLessThanOrEqual(width)
  }
})
