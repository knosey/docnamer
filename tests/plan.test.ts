// The reference the graph runner swaps through GRAPH_REFERENCE; assert against it, never edit it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`getconf NAME_MAX /`

import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_CALL_MS } from './preload.ts'
import { scratch } from './scratch.ts'

/**
 * src/commands.ts and src/cli.ts are loaded INSIDE each check with a dynamic import, never at the top
 * of the file, so a module that is missing or fails to load is a failed check this suite reports — not
 * a throw at load.
 *
 * `getconf NAME_MAX /` is the filesystem truth a naming step must respect: no planned name may exceed
 * it.
 */

// --- consumed shapes (structural mirrors of the interfaces T5 consumes) -----

type FieldSpec = {
  kind: 'text' | 'date' | 'entity' | 'last4'
  required: boolean
  prompt?: string
}
type DocType = {
  describe: string
  fields: Record<string, FieldSpec>
  template: string
  tag?: string
  folder?: string | null
}
type Config = {
  defaults: {
    date_format: string
    date_order: 'day-first' | 'month-first'
    max_name_length: number
    ocr_text_layer: boolean
    finder_tags: boolean
    finder_comment: boolean
  }
  models: { cheap: string; vision: string; strong: string }
  types: Record<string, DocType>
  entities: Record<string, string[]>
}

type PlanRow = {
  old: string
  new: string
  type: string
  fields: Record<string, string>
  evidence: Record<string, string>
  flags: string[]
  summary: string
  size: number
  mtime: number
  status: 'pending' | 'accepted' | 'skipped'
}

type CommandsModule = {
  plan(
    folder: string,
    opts: { recursive: boolean; applyUnflagged: boolean },
    config: Config
  ): Promise<PlanRow[]>
  writePlan(folder: string, rows: PlanRow[]): Promise<void>
}
type CliModule = { main(argv: string[]): Promise<number> }

// --- the reference's own output: the truth this test asserts against --------

/** Run the reference command and return its trimmed stdout: the truth. */
function referenceOutput(): string {
  const argv = reference.split(/\s+/).filter(Boolean)
  if (!argv.length) throw new Error('reference is empty')
  const bin = Bun.which(argv[0]) ?? argv[0]
  const p = Bun.spawnSync([bin, ...argv.slice(1)])
  if (p.exitCode !== 0) {
    throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
  return p.stdout.toString().trim()
}

// --- src/commands.ts and src/cli.ts, loaded as failed checks ----------------

async function loadCommands(): Promise<CommandsModule> {
  try {
    return (await import('../src/commands.ts')) as unknown as CommandsModule
  } catch (e) {
    throw new Error('src/commands.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
}

async function loadCli(): Promise<CliModule> {
  try {
    return (await import('../src/cli.ts')) as unknown as CliModule
  } catch (e) {
    throw new Error('src/cli.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
}

// --- fixtures ---------------------------------------------------------------

const CONFIG: Config = {
  defaults: {
    date_format: 'YYYY-MM-DD',
    date_order: 'day-first',
    max_name_length: 150,
    ocr_text_layer: false,
    finder_tags: true,
    finder_comment: false
  },
  models: { cheap: 'cheap-model', vision: 'vision-model', strong: 'strong-model' },
  types: {
    invoice: {
      describe: 'A bill asking for payment for goods or services',
      fields: {
        date: { kind: 'date', required: true },
        vendor: { kind: 'entity', required: true },
        amount: { kind: 'text', required: false }
      },
      template: '{date} {vendor} - Invoice',
      tag: 'Invoice',
      folder: null
    },
    other: {
      describe: 'Anything that fits no type above',
      fields: { subject: { kind: 'text', required: true } },
      template: '{date} {sender} - {subject}'
    }
  },
  entities: { Acme: ['Acme Ltd', 'ACME'] }
}

/** A throwaway folder holding one seed document, in /tmp (outside the tree). */
function seed(): string {
  const dir = scratch('docnamer-plan')
  writeFileSync(
    join(dir, 'invoice-acme.txt'),
    'INVOICE\nAcme Ltd\nDate: 03/04/2026\nTotal: 482.50 GBP\n'
  )
  return dir
}

const ROW_KEYS = [
  'old',
  'new',
  'type',
  'fields',
  'evidence',
  'flags',
  'summary',
  'size',
  'mtime',
  'status'
]

// --- cases ------------------------------------------------------------------

test('T5 plan returns a PlanRow per document with the declared shape', async () => {
  const c = await loadCommands()
  const dir = seed()
  const rows = await c.plan(dir, { recursive: false, applyUnflagged: false }, CONFIG)
  expect(Array.isArray(rows)).toBe(true)
  expect(rows.length).toBe(1)
  const r = rows[0]!
  expect(r.old).toBe('invoice-acme.txt')
  for (const k of ROW_KEYS) {
    expect(r).toHaveProperty(k)
  }
  expect(['pending', 'accepted', 'skipped']).toContain(r.status)
  expect(r.new.length).toBeLessThanOrEqual(Number(referenceOutput()))
})

test('T5 writePlan writes .docnamer-plan.json in the folder', async () => {
  const c = await loadCommands()
  const dir = seed()
  const rows: PlanRow[] = [
    {
      old: 'invoice-acme.txt',
      new: '2026-04-03 Acme - Invoice.pdf',
      type: 'invoice',
      fields: {},
      evidence: {},
      flags: [],
      summary: 'An invoice from Acme',
      size: 1,
      mtime: 0,
      status: 'pending'
    }
  ]
  await c.writePlan(dir, rows)
  const p = join(dir, '.docnamer-plan.json')
  expect(existsSync(p)).toBe(true)
  expect(readFileSync(p, 'utf8')).toContain('invoice-acme.txt')
})

// `--run` with no value is a truncated command, not "undo the latest": the parser's fallback would
// turn it into a destructive undo of a run nobody named.
test('T5 CLI main refuses `undo --run` with no value', async () => {
  const cli = await loadCli()
  const dir = scratch('docnamer-run')
  const renamed = '2026-04-03 Acme - Invoice.txt'
  writeFileSync(join(dir, renamed), 'INVOICE\nAcme Ltd\n')
  writeFileSync(
    join(dir, '.docnamer-undo-1.json'),
    JSON.stringify({ entries: [{ old: 'invoice-acme.txt', new: renamed }] })
  )
  const code = await cli.main(['undo', dir, '--run'])
  // A truncated flag is refused, and a refusal is 2 (src/cli.ts USAGE_EXIT); 1 is
  // reserved for a run that was accepted and then failed. This asserted 1.
  expect(code).toBe(2)
  expect(existsSync(join(dir, renamed))).toBe(true)
  expect(existsSync(join(dir, 'invoice-acme.txt'))).toBe(false)
})

// `plan` makes one real paid model call, so it waits past bun's 5s default.
test(
  'T5 CLI main plans a folder end to end',
  async () => {
    const cli = await loadCli()
    const dir = seed()
    const code = await cli.main(['plan', dir])
    expect(typeof code).toBe('number')
    expect(code).toBe(0)
    expect(existsSync(join(dir, '.docnamer-plan.json'))).toBe(true)
  },
  MODEL_CALL_MS
)
