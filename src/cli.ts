/**
 * docnamer CLI entry (D3). `docnamer plan <folder>` is the entire integration
 * surface: it writes `<folder>/.docnamer-plan.json` and touches nothing else.
 */
import { loadConfig, CONFIG_FILE, type Config } from './config.ts'
import { plan, writePlan, apply, undo } from './commands.ts'
import { review } from './review.ts'
import { evalTestset, formatEvalReport } from './eval.ts'
import { renderTable } from './table.ts'

/**
 * The built-in config, used when the folder carries no docnamer.json. `other`
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

/**
 * The folder's own config: one name, one location. A folder that does not carry
 * it is planned by DEFAULT_CONFIG — a stale config under any other name is not
 * a config location and is never read.
 */
export async function configFor(folder: string): Promise<Config> {
  const path = `${folder}/${CONFIG_FILE}`
  if (await Bun.file(path).exists()) return loadConfig(path)
  return DEFAULT_CONFIG
}

const USAGE =
  'usage: docnamer plan [--recursive] <folder> | docnamer review <folder> | docnamer apply <folder> | docnamer undo [--run <file>] <folder> | docnamer eval <testset>'

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd !== 'plan' && cmd !== 'review' && cmd !== 'apply' && cmd !== 'undo' && cmd !== 'eval') {
    console.error(USAGE)
    return 1
  }
  let recursive = false
  let run: string | null = null
  let folder: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--recursive' || a === '-r') recursive = true
    else if (a === '--run') run = rest[++i] ?? null
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
  if (cmd === 'eval') {
    // The argument is a test set, not a folder to touch: eval scores it against
    // its expected.yaml and renames nothing (R8, I4).
    const report = await evalTestset(folder, config)
    console.log(formatEvalReport(report))
    return 0
  }
  if (cmd === 'plan') {
    const rows = await plan(folder, { recursive, applyUnflagged: false }, config)
    await writePlan(folder, rows)
    // The table is what a person reads before anything is renamed (I1): the
    // count alone never showed which name a file would get.
    console.log(renderTable(rows))
    console.log(`planned ${rows.length} document(s) -> ${folder}/.docnamer-plan.json`)
    return 0
  }
  if (cmd === 'review') {
    await review(folder, config)
    return 0
  }
  if (cmd === 'apply') {
    const report = await apply(folder, config)
    console.log(`renamed ${report.renamed} file(s) -> ${report.undoFile}`)
    for (const s of report.skipped) console.log(`skipped ${s.file}: ${s.reason}`)
    return 0
  }
  const report = await undo(folder, run, config)
  console.log(`restored ${report.restored} file(s)`)
  for (const s of report.skipped) console.log(`skipped ${s.file}: ${s.reason}`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
