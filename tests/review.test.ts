// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun --version`

/**
 * T3 — Review TUI and its CLI wiring (R4, I3).
 *
 * Exercises the produced surface of src/review.ts and src/cli.ts:
 *   - applyAction(rows, index, action, value, config) applies one ReviewAction
 *     to a plan row and returns the updated rows.
 *   - the CLI dispatches `plan`, `apply`, `undo` and `review`.
 *
 * Missing modules and missing exports are failed checks this test PRINTS, not
 * load-time throws, so a red run is the absence of the work and nothing else.
 */
import { describe, expect, test } from 'bun:test'
import type { Config } from '../src/config.ts'
import { loadConfig } from '../src/config.ts'

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

/** Run the reference command and return its trimmed stdout: the truth. */
function referenceOutput(): string {
  const argv = reference.split(/\s+/).filter(Boolean)
  if (!argv.length) throw new Error('reference is empty')
  const p = Bun.spawnSync(argv)
  if (p.exitCode !== 0) throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  return p.stdout.toString().trim()
}

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

const config = (): Config => loadConfig(`${repo}/docnamer.yaml`)

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
    const p = Bun.spawn([bun, `${repo}/src/cli.ts`, 'review', dir], {
      stdin: new Blob(['A\n']),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env }
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited
    ])
    expect(code, `review must exit 0\n${stderr}${stdout}`).toBe(0)

    const after = JSON.parse(await Bun.file(`${dir}/.docnamer-plan.json`).text()) as Row[]
    expect(after[0]?.status).toBe('accepted')
    expect(after[1]?.status).toBe('pending')
  })

  test('the CLI still dispatches plan and rejects an unknown command', async () => {
    const cli = await importOrNull('../src/cli.ts')
    expect(cli, 'src/cli.ts must exist (T3)').not.toBeNull()
    const main = fn(cli as Record<string, unknown>, 'main') as (argv: string[]) => Promise<number>

    const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-review-${crypto.randomUUID()}`
    Bun.spawnSync(['mkdir', '-p', dir])
    await Bun.write(`${dir}/a.txt`, 'INVOICE\nAcme Ltd\nDate: 03/04/2026\n')
    expect(await main(['plan', dir])).toBe(0)
    expect(await main(['nonsense', dir])).toBe(1)
  })
})
