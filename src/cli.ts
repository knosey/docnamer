/**
 * docnamer CLI entry. `docnamer plan <folder>` is the entire integration
 * surface: it writes `<folder>/.docnamer-plan.json` and touches nothing else.
 *
 * Nothing here writes a byte itself. Every line goes through `ui`, which owns the
 * glyph set, the colour and the ASCII fallback, so a command cannot print
 * something the rest of the program would not.
 */
import { resolve } from 'node:path'
import pkg from '../package.json'
import { loadConfig, CONFIG_FILE, BUILTIN_CONFIG, type Config } from './config.ts'
import {
  credentials,
  docnamerModels,
  login,
  logout,
  ownAuthPath,
  ownCredentials,
  requiredProviders,
  tilde
} from './auth.ts'
import { plan, writePlan, apply, undo, PLAN_FILE } from './commands.ts'
import { review } from './review.ts'
import { evalTestset, formatEvalReport } from './eval.ts'
import { renderTable } from './table.ts'
import { parseDeviceArgs, type DeviceArgs } from './device.ts'
import { pick, releaseStdin, type Option } from './prompt.ts'
import {
  closeDevice,
  hasDevice,
  progressBar,
  setDevice,
  styleFrom,
  ui,
  type Style,
  type Ui
} from './ui.ts'

/**
 * The folder's own config: one name, one location. A folder that does not carry
 * it is planned by the roster the binary was built from.
 */
export async function configFor(folder: string): Promise<Config> {
  const path = `${folder}/${CONFIG_FILE}`
  if (await Bun.file(path).exists()) return loadConfig(path)
  return BUILTIN_CONFIG
}

/** Every flag the parser accepts, in one place so a command's help cannot
 *  advertise one the parser would not understand. */
const OPTIONS = {
  recursive: ['--recursive, -r', 'Include documents in subfolders'],
  run: ['--run <file>', 'Undo a specific run file instead of the most recent'],
  help: ['--help, -h', 'Print help and exit'],
  version: ['--version, -v', 'Print the version and exit']
} as const

type FlagName = keyof typeof OPTIONS

/** An invocation and what it does — the pair the EXAMPLES section renders. */
type Example = readonly [string, string]

type Command = {
  readonly name: string
  readonly args: string
  readonly summary: string
  /** The OPTIONS keys this command accepts. `--help` is added to all of them. */
  readonly flags: readonly FlagName[]
  readonly examples: readonly Example[]
}

/**
 * The roster, and the only place a command is named: the help text is rendered
 * from it, so a command that is dispatched but never documented cannot be
 * written down. `tests/cli-help.test.ts` drives every advertised name for real.
 */
const COMMANDS: readonly Command[] = [
  {
    name: 'plan',
    args: '[--recursive] <folder>',
    summary: 'Show what each document would be renamed to, changing nothing',
    flags: ['recursive'],
    examples: [
      ['docnamer plan ~/Scans', 'the names it would give, nothing touched'],
      ['docnamer plan --recursive ~/Scans', 'include the subfolders too']
    ]
  },
  {
    name: 'review',
    args: '<folder>',
    summary: 'Review a planned run with the model before it is applied',
    flags: [],
    examples: [['docnamer review ~/Scans', 'decide each row, flagged ones first']]
  },
  {
    name: 'apply',
    args: '<folder>',
    summary: 'Rename the documents a plan describes, writing an undo file',
    flags: [],
    examples: [['docnamer apply ~/Scans', 'rename them, and record how to put it back']]
  },
  {
    name: 'undo',
    args: '[--run <file>] <folder>',
    summary: 'Restore the names an applied run changed',
    flags: ['run'],
    examples: [
      ['docnamer undo ~/Scans', 'put the most recent run back'],
      ['docnamer undo --run .docnamer-undo-1.json ~/Scans', 'put that run back']
    ]
  },
  {
    name: 'eval',
    args: '<testset>',
    summary: "Score the renamer against a test set's expected.json",
    flags: [],
    examples: [['docnamer eval tests/testset', 'score it; nothing is renamed']]
  },
  {
    name: 'login',
    args: '[provider]',
    summary: 'Sign in to a model provider and store the credential',
    flags: [],
    examples: [
      ['docnamer login', 'pick a provider from the catalog'],
      ['docnamer login fireworks', 'sign in to one you already know the name of']
    ]
  },
  {
    name: 'logout',
    args: '[provider]',
    summary: 'Remove the credential docnamer stored for a provider',
    flags: [],
    examples: [
      ['docnamer logout', 'pick a credential of docnamer\u2019s own to remove'],
      ['docnamer logout fireworks', 'remove one you already know the name of']
    ]
  },
  {
    name: 'auth',
    args: '',
    summary: 'Report where each provider the configured models use gets its credential',
    flags: [],
    examples: [['docnamer auth', 'say which file each credential came from']]
  }
]

/** What a person types when they do not yet know what to type. */
const PROGRAM_EXAMPLES: readonly Example[] = [
  ['docnamer plan ~/Scans', 'the names it would give, nothing touched'],
  ['docnamer review ~/Scans', 'decide each row, flagged ones first'],
  ['docnamer apply ~/Scans', 'rename them, and record how to put it back'],
  ['docnamer undo ~/Scans', 'put the most recent run back'],
  ['docnamer login', 'pick a provider from the catalog']
]

/** Read from the manifest, never typed here, so the two cannot drift apart. */
const VERSION: string = pkg.version

/**
 * Printed when an invocation is incomplete — the command was named but the
 * folder was not — never when it is unknown, which is a different failure.
 * Lower-case on purpose: it is a usage error, not help.
 */
const BARE_USAGE =
  'usage: docnamer <command> [options] <folder>\nrun `docnamer --help` for the commands this program has'

/**
 * The code for an invocation this program REFUSED: a command it does not have,
 * an argument it cannot accept, a folder it was never given. It is not the same
 * as 1, which is an invocation it accepted and then failed at. A script can only
 * act on that difference if the code carries it, so every refusal returns this
 * one and no refusal invents its own.
 */
const USAGE_EXIT = 2

/**
 * One aligned name column, never narrower than the longest name plus two spaces.
 * The help text is built to a contract `tests/cli-help.test.ts` parses with plain
 * string work: a section heading sits alone on its line, and every line beneath
 * it begins with two spaces, a name, then at least two spaces before its
 * description.
 */
function column(rows: readonly Example[]): string {
  const width = Math.max(...rows.map(([name]) => name.length)) + 2
  return rows.map(([name, text]) => `  ${name.padEnd(width)}${text}`).join('\n')
}

/** The one progress line plan, apply and undo draw beside the throbber. */
const progressLine = (u: Ui, done: number, total: number, file: string): string =>
  `${progressBar(done, total, u.style)} ${done} of ${total} ${u.glyphs.dash} ${file}`

/** The folder a person can recognise. `.` is what they typed, not where the files are. */
function shownFolder(folder: string): string {
  const abs = resolve(folder)
  const home = process.env.HOME
  if (home === undefined || home === '') return abs
  return tilde(abs)
}

/** Lines the throbber cycles while the model has not answered yet. The first
 *  one is the sentence a pipe logs, so it has to name the work and the folder. */
function planQuips(where: string): readonly string[] {
  return [
    `analysing the documents in ${where}`,
    `the paperwork in ${where} is pretending to be organised`,
    `asking the model to admit what ${where} contains`,
    `still in ${where}. nothing has a name yet`
  ]
}

/** The help for the program, or for one command when `cmd` names one. */
function helpText(cmd?: Command): string {
  const sections =
    cmd === undefined
      ? [
          'Rename document scans by what they contain.',
          '',
          'USAGE',
          '  docnamer <command> [options] <folder>',
          '',
          'COMMANDS',
          column(COMMANDS.map(c => [`${c.name} ${c.args}`.trimEnd(), c.summary] as const)),
          '',
          'OPTIONS',
          column([OPTIONS.recursive, OPTIONS.run, OPTIONS.help, OPTIONS.version]),
          '',
          'EXAMPLES',
          column(PROGRAM_EXAMPLES)
        ]
      : [
          `${cmd.summary}.`,
          '',
          'USAGE',
          `  docnamer ${cmd.name} ${cmd.args}`.trimEnd(),
          '',
          'OPTIONS',
          column([...cmd.flags.map(f => OPTIONS[f]), OPTIONS.help]),
          '',
          'EXAMPLES',
          column(cmd.examples)
        ]
  return sections.join('\n')
}

/**
 * The catalog as a list to choose from: the whole catalog, not the providers the
 * shipped config happens to use — and each row says where a credential it already
 * holds lives, because the file is the thing `docnamer auth` and `logout` answer
 * about.
 */
async function catalogOptions(): Promise<Option[]> {
  const models = docnamerModels()
  const held = new Set((await credentials.list()).map(c => c.providerId))
  const options = await Promise.all(
    models.getProviders().map(async (provider): Promise<Option> => {
      const kinds: string[] = []
      if (provider.auth.oauth !== undefined) kinds.push('oauth')
      if (provider.auth.apiKey !== undefined) kinds.push('api key')
      const option: Option = {
        id: provider.id,
        label: provider.name,
        detail: `${provider.id} \u00b7 ${kinds.join(' or ')}`
      }
      if (!held.has(provider.id)) return option
      const origin = await credentials.origin(provider.id)
      if (origin === null) {
        throw new Error(`login: ${provider.id} is listed as held but no store answers for it`)
      }
      return { ...option, status: `signed in \u00b7 ${tilde(origin)}` }
    })
  )
  return options.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The credential list for `logout`. Only docnamer's OWN store can be written, so
 * a credential that is pi's is never offered — a choice the command cannot carry
 * out is not a choice.
 */
function ownedOptions(owned: readonly { providerId: string; type: string }[]): Option[] {
  return owned
    .map(entry => ({
      id: entry.providerId,
      label: entry.providerId,
      detail: entry.type,
      status: `signed in \u00b7 ${tilde(ownAuthPath())}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The three commands that answer about credentials and touch no document. */
async function credentialCommand(
  cmd: string,
  providerId: string | undefined,
  u: Ui,
  style: Style
): Promise<number> {
  if (cmd === 'auth') {
    const missing: string[] = []
    const rows: string[][] = []
    const models = docnamerModels()
    for (const id of requiredProviders(BUILTIN_CONFIG)) {
      const resolved = await models.getAuth(id)
      if (resolved === undefined) {
        missing.push(id)
        continue
      }
      // The file when a store answered — the label `source` gives names the
      // mechanism (`FIREWORKS_API_KEY`), which is not the same question.
      const origin = await credentials.origin(id)
      const where = origin === null ? resolved.source : origin
      if (where === undefined) {
        throw new Error(`auth: ${id} resolved with neither a stored credential nor a source`)
      }
      rows.push([id, tilde(where)])
    }
    if (missing.length > 0) {
      u.err(
        u.fail(
          `no credential for ${missing.join(', ')}`,
          'run `docnamer login` to pick a provider and sign in'
        )
      )
      return 1
    }
    u.log(u.head('Credentials'))
    u.log(u.table(['PROVIDER', 'FROM'], rows))
    return 0
  }

  if (cmd === 'logout') {
    if (providerId !== undefined) {
      await logout(providerId)
      u.log(u.ok(`signed out of ${providerId}`))
      return 0
    }
    const owned = await ownCredentials()
    if (owned.length === 0) {
      u.log(u.note('no credential of docnamer\u2019s own to sign out of'))
      return 0
    }
    const id = await pick('Sign out of a provider', ownedOptions(owned), style)
    if (id === null) return 0
    await logout(id)
    u.log(u.ok(`signed out of ${id}`))
    return 0
  }

  const id = providerId ?? (await pick('Sign in to a provider', await catalogOptions(), style))
  if (id === null) return 0
  await login(id, u, {})
  u.log(u.ok(`signed in to ${id} ${u.dim(u.glyphs.dash)} stored in ${tilde(ownAuthPath())}`))
  return 0
}

/** The wrapper's own flags, in one list so the parser cannot strip one and
 *  dispatch another. Each carries a value, so stripping skips two tokens. */
const DEVICE_FLAGS = ['--tty', '--cols', '--rows', '--exit-file', '--cwd']

/** argv without the device flags, so the command after them still runs. */
function stripDeviceFlags(argv: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (DEVICE_FLAGS.includes(argv[i] as string)) i += 1
    else kept.push(argv[i] as string)
  }
  return kept
}

export async function main(argv: string[]): Promise<number> {
  // The wrapper's device flags name the terminal this process was launched
  // away from; when they are present the device is the only way in and out.
  const device = parseDeviceArgs(argv)
  if (device.tty !== null) setDevice(device.tty, device.cols, device.rows)
  // A device is always a tty of the size the wrapper measured, whatever the
  // process's own fds are. styleFrom is the whole capability gate, fallbacks
  // included.
  const style: Style = styleFrom(process.env, hasDevice() || process.stdout.isTTY === true)
  const u = ui(style)
  const [cmd, ...rest] = stripDeviceFlags(argv)

  // The front door, answered before any command runs or any folder is read.
  if (cmd === '--help' || cmd === '-h') {
    u.log(helpText())
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    u.log(`docnamer ${VERSION}`)
    return 0
  }
  if (cmd === undefined) {
    u.err(BARE_USAGE)
    return USAGE_EXIT
  }
  const command = COMMANDS.find(c => c.name === cmd)
  if (command === undefined) {
    // Naming the token is what makes the typo visible; the code says the
    // invocation was refused rather than that a run failed.
    u.err(
      u.fail(
        `unknown command \`${cmd}\``,
        'run `docnamer --help` for the commands this program has'
      )
    )
    return USAGE_EXIT
  }

  // A question about one command, answered before it touches a folder.
  if (rest.includes('--help') || rest.includes('-h')) {
    u.log(helpText(command))
    return 0
  }

  if (cmd === 'auth' || cmd === 'login' || cmd === 'logout') {
    const [providerId, ...extra] = rest
    if (extra.length > 0) {
      u.err(u.fail(`\`${cmd}\` takes at most one provider`, `run \`docnamer ${cmd} --help\``))
      return USAGE_EXIT
    }
    return credentialCommand(cmd, providerId, u, style)
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
        u.err(BARE_USAGE)
        return USAGE_EXIT
      }
      run = value
    } else if (folder === null) folder = a
    else {
      u.err(BARE_USAGE)
      return USAGE_EXIT
    }
  }
  if (folder === null) {
    u.err(BARE_USAGE)
    return USAGE_EXIT
  }

  const config = await configFor(folder)
  if (cmd === 'eval') {
    // The argument is a test set, not a folder to touch: eval scores it against
    // its expected.json and renames nothing.
    const spinner = u.spinner(`scoring ${folder} against its expected.json`)
    const report = await evalTestset(folder, config)
    spinner.stop(`scored ${report.files} file(s)`)
    u.log(formatEvalReport(report))
    return 0
  }
  if (cmd === 'plan') {
    // The throbber opens on a sentence: a percentage before the folder is
    // counted would claim progress nobody made. Once the count is known the
    // bar sits at 0% beside that sentence until a document actually finishes.
    const where = shownFolder(folder)
    const quips = planQuips(where)
    let q = 0
    let counted = false
    let known = 0
    let live = true
    const waiting = (): string => {
      const joke = quips[q]
      if (joke === undefined) throw new Error(`cli: plan quip ${q} missing`)
      if (!counted) return joke
      return `${progressBar(0, known, style)} ${joke}`
    }
    const spinner = u.spinner(waiting())
    const tease = setInterval(() => {
      if (!live) return
      q = (q + 1) % quips.length
      spinner.update(waiting())
    }, 2500)
    tease.unref()
    let rows: Awaited<ReturnType<typeof plan>>
    try {
      rows = await plan(
        folder,
        { recursive, applyUnflagged: false },
        config,
        (done, total, file) => {
          counted = true
          known = total
          if (done === 0) {
            spinner.update(waiting())
            return
          }
          live = false
          clearInterval(tease)
          spinner.update(progressLine(u, done, total, file))
        }
      )
      await writePlan(folder, rows)
    } finally {
      live = false
      clearInterval(tease)
    }
    // The completion line draws the final bar in the same format the
    // in-progress bars drew; an empty folder reads 0%, never a full bar.
    spinner.stop(
      `${progressBar(rows.length, rows.length, style)} planned ${rows.length} document(s)`
    )
    // The table is what a person reads before anything is renamed: the count
    // alone never showed which name a file would get.
    u.log(renderTable(rows, style))
    u.log(u.note(`plan written to ${folder}/${PLAN_FILE} ${u.glyphs.dash} run \`docnamer review\``))
    return 0
  }
  if (cmd === 'review') {
    await review(folder, config, u)
    return 0
  }
  if (cmd === 'apply') {
    const spinner = u.spinner(`renaming the documents in ${folder}`)
    const report = await apply(folder, config, (done, total, file) => {
      spinner.update(progressLine(u, done, total, file))
    })
    // The completion line draws the full bar, as plan's does: the fraction
    // was known at every step, so the finish shows it.
    const applied = report.renamed + report.skipped.length
    spinner.stop(`${progressBar(applied, applied, style)} renamed ${report.renamed} file(s)`)
    for (const s of report.skipped) u.log(u.warn(`skipped ${s.file}: ${s.reason}`))
    u.log(u.note(`undo file ${report.undoFile} ${u.glyphs.dash} \`docnamer undo\` puts it back`))
    return 0
  }
  const spinner = u.spinner(`restoring the names in ${folder}`)
  const report = await undo(folder, run, config, (done, total, file) => {
    spinner.update(progressLine(u, done, total, file))
  })
  const restoredCount = report.restored.length + report.skipped.length
  spinner.stop(
    `${progressBar(restoredCount, restoredCount, style)} restored ${report.restored.length} file(s)`
  )
  // The names, not a count: after an operation whose whole point is
  // reversibility, a person has to see which file is sitting at which name.
  for (const name of report.restored) u.log(u.ok(`restored ${name}`))
  for (const s of report.skipped) u.log(u.warn(`skipped ${s.file}: ${s.reason}`))
  return 0
}

/**
 * The report for a refusal the OS made, or null when the error is not one.
 *
 * A bare `EACCES: permission denied, open '…'` names the errno and no way forward
 * — and the folders a person points docnamer at first, Downloads, Desktop and
 * Documents, are exactly the ones macOS protects, so this is the one place that
 * knows what the reader can do about it. Bun's glob error carries `code` and
 * `path` (verified against a chmod 000 folder), so the folder is read off the
 * error rather than parsed out of its message.
 */
function refusal(e: unknown): { what: string; help: string } | null {
  if (typeof e !== 'object' || e === null) return null
  const { code, path } = e as { code?: unknown; path?: unknown }
  if (code !== 'EACCES' && code !== 'EPERM') return null
  if (typeof path !== 'string') return null
  return {
    what: `cannot read ${path} \u2014 permission denied`,
    help: 'macOS protects Downloads, Desktop and Documents: System Settings \u203a Privacy & Security \u203a Files and Folders, and switch your terminal on; anywhere else, check the folder\u2019s permissions'
  }
}

if (import.meta.main) {
  const device: DeviceArgs = parseDeviceArgs(Bun.argv.slice(2))
  // A LaunchServices launch starts the app in "/", so a relative folder only
  // means what the person typed if the directory the wrapper carried across is
  // restored before any command reads it. Absolute paths do not care either way.
  if (device.cwd !== null) process.chdir(device.cwd)
  try {
    process.exitCode = await main(Bun.argv.slice(2))
  } catch (e) {
    // A failure is never a stack trace: the message carries what broke and how
    // to fix it, and the exit code says it failed.
    const u = ui(styleFrom(process.env, process.stdout.isTTY === true))
    const refused = refusal(e)
    u.err(
      refused === null
        ? u.fail(e instanceof Error ? e.message : String(e))
        : u.fail(refused.what, refused.help)
    )
    process.exitCode = 1
  } finally {
    // Hand stdin back before the process is allowed to end: a reader left on
    // Bun's stdin stream holds the event loop open, so a command that prompted
    // would print its result and then never return the prompt.
    await releaseStdin()
    // Flush the last bytes to the device, then leave the exit code where the
    // wrapper waits for it: `open -W` always reports 0, so the file is the only
    // channel the code can travel by.
    await closeDevice()
    if (device.exitFile !== null) await Bun.write(device.exitFile, String(process.exitCode ?? 0))
  }
}
