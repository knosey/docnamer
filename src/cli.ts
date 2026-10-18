/**
 * docnamer CLI entry (D3). `docnamer plan <folder>` is the entire integration
 * surface: it writes `<folder>/.docnamer-plan.json` and touches nothing else.
 */
import { loadConfig, type Config } from './config.ts'
import { plan, writePlan } from './commands.ts'
import { renderTable } from './table.ts'

/**
 * The built-in config, used when the folder carries no docnamer.yaml. `other`
 * is always in the roster as the fallback of last resort (R2, R7).
 */
const DEFAULT_CONFIG: Config = {
  defaults: {
    date_format: 'YYYY-MM-DD',
    date_order: 'day-first',
    max_name_length: 150,
    ocr_text_layer: false,
    finder_tags: false,
    finder_comment: false
  },
  models: {
    cheap: 'anthropic/claude-haiku-4-5',
    vision: 'anthropic/claude-sonnet-4-5',
    strong: 'anthropic/claude-sonnet-4-5'
  },
  types: {
    invoice: {
      describe: 'A bill asking for payment for goods or services',
      fields: {
        date: { kind: 'date', required: true },
        vendor: { kind: 'entity', required: true }
      },
      template: '{date} {vendor} - Invoice'
    },
    letter: {
      describe: 'Personal or business correspondence',
      fields: {
        date: { kind: 'date', required: false },
        sender: { kind: 'entity', required: false },
        subject: { kind: 'text', required: true }
      },
      template: '{date} {sender} - {subject}'
    },
    receipt: {
      describe: 'Proof of a completed purchase',
      fields: {
        date: { kind: 'date', required: true },
        vendor: { kind: 'entity', required: true }
      },
      template: '{date} {vendor} - Receipt'
    },
    statement: {
      describe: 'A bank or card statement',
      fields: {
        date: { kind: 'date', required: true },
        account: { kind: 'last4', required: false },
        bank: { kind: 'entity', required: false }
      },
      template: '{date} {bank} - Statement'
    },
    other: {
      describe: 'Anything that fits no type above',
      fields: { subject: { kind: 'text', required: true } },
      template: '{date} {sender} - {subject}'
    }
  },
  entities: {}
}

async function configFor(folder: string): Promise<Config> {
  for (const name of ['docnamer.yaml', 'docnamer.yml', '.docnamer.yaml', '.docnamer.yml']) {
    if (await Bun.file(`${folder}/${name}`).exists()) return loadConfig(`${folder}/${name}`)
  }
  return DEFAULT_CONFIG
}

const USAGE = 'usage: docnamer plan [--recursive] <folder>'

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd !== 'plan') {
    console.error(USAGE)
    return 1
  }
  let recursive = false
  let folder: string | null = null
  for (const a of rest) {
    if (a === '--recursive' || a === '-r') recursive = true
    else if (folder === null) folder = a
    else {
      console.error(USAGE)
      return 1
    }
  }
  if (folder === null) {
    console.error(USAGE)
    return 1
  }

  const config = await configFor(folder)
  const rows = await plan(folder, { recursive, applyUnflagged: false }, config)
  await writePlan(folder, rows)
  // The table is what a person reads before anything is renamed (I1): the
  // count alone never showed which name a file would get.
  console.log(renderTable(rows))
  console.log(`planned ${rows.length} document(s) -> ${folder}/.docnamer-plan.json`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
