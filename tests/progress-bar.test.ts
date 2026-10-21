// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? "locale charmap"

import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { styleFrom, type Style } from '../src/ui.ts'

/**
 * The completion bar I5 asserts: ten filled blocks and the finished percentage,
 * the same format the in-progress bars (I4) draw.
 */
const FULL_BAR = '\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0 100%'

/** The block glyphs the unicode path draws and the ASCII path must not. */
const BLOCKS = /[\u25b0\u25b1]/

/** Run the reference command and return its trimmed stdout. */
const referenceOutput = (): string => {
  const [cmd, ...args] = reference.split(/\s+/).filter(Boolean)
  const proc = Bun.spawnSync([cmd as string, ...args])
  return proc.stdout.toString().trim()
}

/**
 * `progressBar(done, total, style)` is the piece this task consumes; it is
 * loaded at check time so a missing export is a printed failure, not a load
 * throw.
 */
const loadProgressBar = async (): Promise<(done: number, total: number, style: Style) => string> => {
  const mod = (await import('../src/ui.ts')) as unknown as {
    progressBar?: (done: number, total: number, style: Style) => string
  }
  if (typeof mod.progressBar !== 'function') {
    throw new Error('progress-bar: src/ui.ts does not export progressBar(done, total, style)')
  }
  return mod.progressBar
}

test('the reference charmap is the precondition the block bar stands on', () => {
  const charmap = referenceOutput()
  expect(charmap, `reference \`${reference}\` printed no charmap`).not.toBe('')
  const style = styleFrom({ LANG: charmap }, true)
  expect(style.unicode, `charmap ${charmap} cannot draw the block bar`).toBe(true)
})

test('a completed run draws the full block bar (I5)', async () => {
  const progressBar = await loadProgressBar()
  const style = styleFrom({ LANG: referenceOutput() }, true)
  expect(progressBar(4, 4, style)).toBe(FULL_BAR)
  expect(progressBar(1, 1, style)).toBe(FULL_BAR)
})

test('a run in progress draws a partial block bar with a rising percentage (I4)', async () => {
  const progressBar = await loadProgressBar()
  const style = styleFrom({ LANG: referenceOutput() }, true)
  const half = progressBar(1, 2, style)
  expect(half, 'the in-progress bar is a ten-block bar and a percentage').toMatch(
    /^[\u25b0\u25b1]{10} \d+%$/
  )
  expect(half.endsWith(' 50%'), 'one of two documents is half done').toBe(true)
  expect(half.startsWith('\u25b0'), 'the filled blocks come first').toBe(true)
  expect(progressBar(1, 4, style).endsWith(' 25%'), 'the percentage follows the count').toBe(true)
})

test('a non-UTF-8 terminal gets an ASCII bar, never the blocks (R5, R6)', async () => {
  const progressBar = await loadProgressBar()
  const style = styleFrom({ LANG: 'C' }, true)
  expect(style.unicode, 'a C locale cannot draw the block glyphs').toBe(false)
  const line = progressBar(1, 2, style)
  expect(BLOCKS.test(line), `the ASCII bar drew block glyphs: ${line}`).toBe(false)
  expect(line.endsWith(' 50%'), 'the ASCII bar still carries the percentage').toBe(true)
})

test('commands.apply drives the progress callback into the completion line (T3 wiring)', async () => {
  const progressBar = await loadProgressBar()
  const commands = (await import('../src/commands.ts')) as unknown as {
    PLAN_FILE: string
    apply(
      folder: string,
      config: unknown,
      progress?: (done: number, total: number, file: string) => void
    ): Promise<unknown>
  }
  const dir = await mkdtemp(join(tmpdir(), 'docnamer-progress-'))
  try {
    const rows = [{ old: 'a.txt', new: 'b.txt', status: 'accepted', size: 0, mtime: 0 }]
    await Bun.write(join(dir, commands.PLAN_FILE), JSON.stringify(rows))
    const calls: [number, number, string][] = []
    await commands.apply(dir, {}, (done, total, file) => {
      calls.push([done, total, file])
    })
    expect(calls.length, 'apply never called progress: the bar is not wired').toBe(1)
    expect(calls[0]).toEqual([1, 1, 'a.txt'])
    const style = styleFrom({ LANG: referenceOutput() }, true)
    const last = calls[calls.length - 1] as [number, number, string]
    expect(progressBar(last[0], last[1], style), 'the completion line is the full bar').toBe(
      FULL_BAR
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
