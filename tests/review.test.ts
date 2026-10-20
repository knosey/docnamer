/**
 * Exercises the produced surface of src/review.ts and src/cli.ts: applyAction(rows, index, action,
 * value, config) applies one ReviewAction to a plan row and returns the updated rows, and the CLI
 * dispatches `plan`, `apply`, `undo` and `review`.
 *
 * Missing modules and missing exports are failed checks this test PRINTS, not load-time throws, so a
 * red run is the absence of the work and nothing else.
 */
import { describe, expect, test } from 'bun:test'
import { runChild } from './child.ts'
import type { Config } from '../src/config.ts'
import { loadConfig } from '../src/config.ts'
import { MODEL_CALL_MS } from './preload.ts'

const repo = import.meta.dir.replace(/\/tests$/, '')

type Row = {
  old: string
  new: string
  type: string
  method: 'text' | 'ocr' | 'vision' | null
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

const row = (over: Partial<Row> = {}): Row => ({
  old: 'invoice-acme-2026-04.txt',
  new: '2026-04-03 Acme Ltd - Invoice.txt',
  type: 'invoice',
  method: 'text',
  fields: { date: '2026-04-03', vendor: 'Acme Ltd' },
  evidence: { vendor: 'Acme Ltd' },
  flags: [],
  summary: 'Acme Ltd invoice',
  size: 64,
  mtime: 1_700_000_000_000,
  status: 'pending',
  ...over
})

async function importOrNull(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(path)) as Record<string, unknown>
  } catch {
    return null
  }
}

async function reviewModule(): Promise<Record<string, unknown>> {
  const m = await importOrNull('../src/review.ts')
  expect(m, 'src/review.ts must exist (T3)').not.toBeNull()
  return m as Record<string, unknown>
}

function fn(mod: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const f = mod[name]
  expect(typeof f, `src/review.ts must export ${name} (T3)`).toBe('function')
  return f as (...args: unknown[]) => unknown
}

const config = (): Config => loadConfig(`${repo}/docnamer.json`)

describe('T3 applyAction', () => {
  test('accept marks the addressed row accepted and leaves the rest alone', async () => {
    const m = await reviewModule()
    const applyAction = fn(m, 'applyAction')
    const rows = [row(), row({ old: 'letter.txt', new: 'Letter.txt', type: 'letter' })]
    const out = (await applyAction(rows, 0, 'accept', null, config())) as Row[]
    expect(out[0]?.status).toBe('accepted')
    expect(out[1]?.status).toBe('pending')
  })

  test('skip marks the addressed row skipped', async () => {
    const m = await reviewModule()
    const applyAction = fn(m, 'applyAction')
    const out = (await applyAction([row()], 0, 'skip', null, config())) as Row[]
    expect(out[0]?.status).toBe('skipped')
  })

  test('edit writes the given name and accepts the row', async () => {
    const m = await reviewModule()
    const applyAction = fn(m, 'applyAction')
    const out = (await applyAction([row()], 0, 'edit', 'Chosen Name.txt', config())) as Row[]
    expect(out[0]?.new).toBe('Chosen Name.txt')
    expect(out[0]?.status).toBe('accepted')
  })

  test('retype changes the row type and accepts it', async () => {
    const m = await reviewModule()
    const applyAction = fn(m, 'applyAction')
    const out = (await applyAction([row()], 0, 'retype', 'receipt', config())) as Row[]
    expect(out[0]?.type).toBe('receipt')
    expect(out[0]?.status).toBe('accepted')
  })

  test('accept-unflagged accepts flag-free rows and leaves flagged rows pending', async () => {
    const m = await reviewModule()
    const applyAction = fn(m, 'applyAction')
    const rows = [
      row(),
      row({ old: 'scan.pdf', flags: ['low-confidence'] }),
      row({ old: 'letter.txt', flags: [] })
    ]
    const out = (await applyAction(rows, 0, 'accept-unflagged', null, config())) as Row[]
    expect(out[0]?.status).toBe('accepted')
    expect(out[1]?.status).toBe('pending')
    expect(out[2]?.status).toBe('accepted')
  })
})

describe('T3 review() and the CLI wiring', () => {
  test('the CLI dispatches review, updating row statuses in the plan file', async () => {
    const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-review-${crypto.randomUUID()}`
    Bun.spawnSync(['mkdir', '-p', dir])
    const rows = [row(), row({ old: 'scan.pdf', flags: ['low-confidence'] })]
    await Bun.write(`${dir}/.docnamer-plan.json`, JSON.stringify(rows, null, 2))

    const bun = Bun.which('bun') ?? 'bun'
    const run = await runChild([bun, `${repo}/src/cli.ts`, 'review', dir], {
      input: 'A',
      timeoutMs: MODEL_CALL_MS
    })
    expect(run.code, `review must exit 0\n${run.stderr}${run.stdout}`).toBe(0)

    const after = JSON.parse(await Bun.file(`${dir}/.docnamer-plan.json`).text()) as Row[]
    expect(after[0]?.status).toBe('accepted')
    expect(after[1]?.status).toBe('pending')
  })

  // R4/I3: "Enter accept". A person reads the key list and presses Enter, so the
  // prompt has to name Enter and Enter has to accept the row on screen.
  test('the CLI accepts the row on Enter and the prompt names Enter as accept', async () => {
    const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-review-${crypto.randomUUID()}`
    Bun.spawnSync(['mkdir', '-p', dir])
    const rows = [row(), row({ old: 'scan.pdf' })]
    await Bun.write(`${dir}/.docnamer-plan.json`, JSON.stringify(rows, null, 2))

    const bun = Bun.which('bun') ?? 'bun'
    const run = await runChild([bun, `${repo}/src/cli.ts`, 'review', dir], {
      input: '\r',
      timeoutMs: MODEL_CALL_MS
    })
    expect(run.code, `review must exit 0\n${run.stderr}${run.stdout}`).toBe(0)
    expect(run.stdout, 'the key list must name Enter as the accept key').toContain('Enter accept')

    const after = JSON.parse(await Bun.file(`${dir}/.docnamer-plan.json`).text()) as Row[]
    expect(after[0]?.status, 'Enter must accept the row on screen').toBe('accepted')
    expect(after[1]?.status).toBe('pending')
  })

  // `plan` makes one real paid model call, so it waits past bun's 5s default.
  test(
    'the CLI still dispatches plan and rejects an unknown command',
    async () => {
      const cli = await importOrNull('../src/cli.ts')
      expect(cli, 'src/cli.ts must exist (T3)').not.toBeNull()
      const main = fn(cli as Record<string, unknown>, 'main') as (argv: string[]) => Promise<number>

      const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-review-${crypto.randomUUID()}`
      Bun.spawnSync(['mkdir', '-p', dir])
      await Bun.write(`${dir}/a.txt`, 'INVOICE\nAcme Ltd\nDate: 03/04/2026\n')
      expect(await main(['plan', dir])).toBe(0)
      // An unknown command is a refusal: 2, not the 1 reserved for an accepted
      // run that then failed (src/cli.ts USAGE_EXIT).
      expect(await main(['nonsense', dir])).toBe(2)
    },
    MODEL_CALL_MS
  )
})
