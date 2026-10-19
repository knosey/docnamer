/**
 * docnamer CLI entry (D3). `docnamer plan <folder>` is the entire integration
 * surface: it writes `<folder>/.docnamer-plan.json` and touches nothing else.
 */
import pkg from '../package.json'
import { loadConfig, CONFIG_FILE, BUILTIN_CONFIG, type Config } from './config.ts'
import { plan, writePlan, apply, undo } from './commands.ts'
import { review } from './review.ts'
import { evalTestset, formatEvalReport } from './eval.ts'
import { renderTable } from './table.ts'

/**
 * The folder's own config: one name, one location. A folder that does not carry
 * it is planned by the roster the binary was built from — a stale config under
 * any other name is not a config location and is never read.
 */
export async function configFor(folder: string): Promise<Config> {
  const path = `${folder}/${CONFIG_FILE}`
  if (await Bun.file(path).exists()) return loadConfig(path)
  return BUILTIN_CONFIG
}

/**
 * The roster, and the only place a command is named: the help text is rendered
 * from it, so a command that is dispatched but never documented cannot be
 * written down. `tests/cli-help.test.ts` drives every advertised name for real.
 */
const COMMANDS = [
  {
    name: 'plan',
    args: '[--recursive] <folder>',
    summary: 'Show what each document would be renamed to, changing nothing'
  },
  {
    name: 'review',
    args: '<folder>',
    summary: 'Review a planned run with the model before it is applied'
  },
  {
    name: 'apply',
    args: '<folder>',
    summary: 'Rename the documents a plan describes, writing an undo file'
  },
  {
    name: 'undo',
    args: '[--run <file>] <folder>',
    summary: 'Restore the names an applied run changed'
  },
  {
    name: 'eval',
    args: '<testset>',
    summary: "Score the renamer against a test set's expected.yaml"
  }
] as const

/** Every flag the parser accepts, documented once because all five commands share it. */
const OPTIONS = [
  ['--recursive, -r', 'Include documents in subfolders'],
  ['--run <file>', 'Undo a specific run file instead of the most recent'],
  ['--help, -h', 'Print help and exit'],
  ['--version, -v', 'Print the version and exit']
] as const

/** Read from the manifest, never typed here, so the two cannot drift apart. */
const VERSION: string = pkg.version

/**
 * Printed when an invocation is incomplete — the command was named but the
 * folder was not — never when it is unknown, which is a different failure with
 * a different exit code. Lower-case on purpose: it is a usage error, not help.
 */
const BARE_USAGE =
  'usage: docnamer <command> [options] <folder>\nrun `docnamer --help` for the commands this program has'

/**
 * One aligned name column, never narrower than the longest name plus two
 * spaces. The help text is built to a contract `tests/cli-help.test.ts` parses
 * with plain string work: a section heading sits alone on its line, and every
 * line beneath it begins with two spaces, a name, then at least two spaces
 * before its description.
 */
function column(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([name]) => name.length)) + 2
  return rows.map(([name, text]) => `  ${name.padEnd(width)}${text}`).join('\n')
}

/** The help for the program, or for one command when `cmd` names one. */
function helpText(cmd?: (typeof COMMANDS)[number]): string {
  const head =
    cmd === undefined
      ? [
          'Rename document scans by what they contain.',
          '',
          'USAGE',
          '  docnamer <command> [options] <folder>',
          '',
          'COMMANDS',
          column(COMMANDS.map(c => [`${c.name} ${c.args}`, c.summary] as const))
        ]
      : [`${cmd.summary}.`, '', 'USAGE', `  docnamer ${cmd.name} ${cmd.args}`]
  return [...head, '', 'OPTIONS', column(OPTIONS)].join('\n')
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv

  // The front door, answered before any command runs or any folder is read.
  if (cmd === '--help' || cmd === '-h') {
    console.log(helpText())
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`docnamer ${VERSION}`)
    return 0
  }
  if (cmd === undefined) {
    console.error(BARE_USAGE)
    return 1
  }
  const command = COMMANDS.find(c => c.name === cmd)
  if (command === undefined) {
    // 2, not 1: the invocation was understood and refused, and naming the token
    // is what makes the typo visible.
    console.error(`docnamer: unknown command \`${cmd}\``)
    console.error('run `docnamer --help` for the commands this program has')
    return 2
  }

  // A question about one command, answered before it touches a folder.
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(helpText(command))
    return 0
  }
  let recursive = false
  let run: string | null = null
  let folder: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--recursive' || a === '-r') recursive = true
    else if (a === '--run') {
      // A truncated flag is a malformed command, never a default: silently
      // undoing the latest run is a destructive action nobody asked for.
      const value = rest[++i]
      if (value === undefined) {
        console.error(BARE_USAGE)
        return 1
      }
      run = value
    } else if (folder === null) folder = a
    else {
      console.error(BARE_USAGE)
      return 1
    }
  }
  if (folder === null) {
    console.error(BARE_USAGE)
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
  // The names, not a count (I2): after an operation whose whole point is
  // reversibility, a person has to see which file is sitting at which name.
  console.log(`restored ${report.restored.length} file(s)`)
  for (const name of report.restored) console.log(`restored ${name}`)
  for (const s of report.skipped) console.log(`skipped ${s.file}: ${s.reason}`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2))
}
