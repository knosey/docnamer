/**
 * Shared e2e harness for the terminal-ux-polish feature
 * (docs/features/terminal-ux-polish/INTERACTIONS.md).
 *
 * One exported function per node of the six digraphs. A flow test is its
 * digraph's steps called in order plus the assertion of its Outcome:
 *
 *   const s = new Session()
 *   await run_version(s); await capture_pty_frame(s); await no_stray_percent(s); await prompt_on_own_line(s)
 *
 * The steps drive the real artifact — the installed `~/bin/docnamer` wrapper on
 * a real pty for the wrapper flows (I1), the CLI on a pty for the review and
 * analysis flows (I2-I5), and the CLI on a pipe for the fallback flow (I6) — and
 * observe the frame it drew, the plan it wrote and the exit it returned. Nothing
 * is asserted about how a screen looked beyond the characters the interaction
 * names; a frame is a byte stream and a redraw looks broken to a grep.
 *
 * Every run is self-contained: a fresh temp folder with a seeded plan, a CLI
 * resolved per run, and nothing written into the repo outside
 * `.audit/screenshots/` (the frame writer). The flows run side by side, so no
 * step depends on a name another run could also hold.
 *
 * A step whose claim the current tree cannot yet satisfy throws — the flows are
 * red until T1-T6 land. A step whose claim no observation surface can see
 * throws `Skipped`, a machine-readable hole, rather than passing.
 *
 * This is test code, so `node:` built-ins and test helpers are fine here.
 */
import { writePlan, PLAN_FILE, type PlanRow } from '../src/commands.ts'
import { wrapper } from './app-binary.ts'
import { runChild, type ChildRun } from './child.ts'
import { resolveCli } from './doc-renamer-apply-harness.ts'
import { readdirSync, rmSync } from 'node:fs'
import { frame, FRAMES_DIR } from './frame.ts'
import { ANSI, makeTerminal, SCREEN_COLS, type Run, type Term } from './pty.ts'
import { ensureProviderKey, MODEL_CALL_MS } from './preload.ts'
import { scratch } from './scratch.ts'

/** Repo root, so a spec can read the tree this run belongs to. */
export const repo = import.meta.dir.replace(/\/tests$/, '')

/** A named hole: the claim cannot be closed on the current observation surface. */
class Skipped extends Error {
  readonly skip = true
  constructor(readonly claim: string) {
    super('SKIP: ' + claim)
    this.name = 'Skipped'
  }
}

/** The version line the wrapper prints, read off a captured frame. */
const VERSION_LINE = /^docnamer\s+\S+/m

// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
const reference = process.env.GRAPH_REFERENCE ?? 'plutil -extract version raw package.json'
/** The truth I4–I6's bar compares against — the charmap, their task's own reference in the workplan, swapped the
 *  same way. Read off the version reference, the bar was always ASCII and no UTF-8 terminal could pass. */
const charmapReference = process.env.GRAPH_REFERENCE ?? 'locale charmap'

/** Run a reference command and return its trimmed stdout. */
const outputOf = (command: string): string => {
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean)
  const proc = Bun.spawnSync([cmd as string, ...args])
  return proc.stdout.toString().trim()
}
const referenceOutput = (): string => outputOf(reference)

/** The bar line the reference's charmap draws at 100%: FULL_BAR on a UTF-8
 *  locale, ASCII `#`s where the charmap says otherwise — the truth the
 *  swapped reference turns against the block bar the CLI draws. */
const referenceFullBar = (): string =>
  /utf-?8/i.test(outputOf(charmapReference)) ? FULL_BAR : `${'#'.repeat(10)} 100%`

/** The full-block glyph the reference's charmap can draw. */
const referenceFullBlock = (): string => referenceFullBar().charAt(0)

/** The controls header I2/I3 keep on screen: the keys and the position. */
export const CONTROLS = /keys:.*accept.*skip.*edit/s

/** The full completion bar I5 asserts. */
export const FULL_BAR = '\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0 100%'

/** The block glyphs the unicode path draws and the ASCII path must not. */
const BLOCKS = /[\u25b0\u25b1\u2500-\u257f]/

/** Three review rows, enough that scrolling and revisiting are both reachable. */
function seedRows(): PlanRow[] {
  const rows: Array<[string, string]> = [
    ['a-receipt.pdf', '2024-03-12 acme receipt.pdf'],
    ['b-receipt.pdf', '2024-03-13 globex receipt.pdf'],
    ['c-receipt.pdf', '2024-03-14 initech receipt.pdf']
  ]
  return rows.map(([old, newName]) => ({
    old,
    new: newName,
    type: 'receipt',
    method: 'text',
    fields: { date: '2024-03-12' },
    evidence: { date: 'Date 12 March 2024' },
    flags: [],
    summary: `A receipt named ${old}.`,
    size: 10,
    mtime: 0,
    status: 'pending'
  }))
}

/** A live process on its own pty, with the wait that replaces a sleep. */
type Live = {
  term: Term
  proc: ReturnType<typeof Bun.spawn>
  /** Type `keys`; the next `waitFor` looks only at what is written after them. */
  write(keys: string): void
  reset(): void
  /** Wait for `marker` in the output written since the last keys were typed. */
  waitFor(marker: string, ms?: number): Promise<void>
  /** Wait until the screen a person sees shows `state`, and return that screen. */
  waitForScreen(state: string, ms?: number): Promise<string>
  seen(): string
  screen(): Promise<string>
  finish(ms?: number): Promise<Run>
  close(): void
}

export class Session {
  /** Per-run working folder. */
  dir = ''
  /** `<dir>/.docnamer-plan.json`. */
  planPath = ''
  /** Resolved CLI argv, or null when no `docnamer` is reachable. */
  cli: string[] | null = null
  booted = false
  /** The wrapper-on-a-shell run I1 drives. */
  shell: Live | null = null
  /** The review session I2/I3 drive. */
  review: Live | null = null
  /** The analysis session I4/I5 drive. */
  analysis: Live | null = null
  /** The folder I4–I6 plan: documents to analyse, apart from the seeded plan's folder. */
  analysisDir = ''
  /** The latest captured review frame. */
  reviewFrame = ''
  /** Successive distinct analysis frames, in the order the terminal showed them. */
  analysisFrames: string[] = []
  /** The text capture_pty_frame rasterised — asserted legible, not just written. */
  versionFrame = ''
  /** The screen with the throbber and bar on it, taken when the bar was seen. */
  throbberFrame = ''
  /** The screen the run left behind when it finished, bar and all. */
  completionFrame = ''
  /** The text capture_frames rasterised for I4. */
  framedAnalysis = ''
  /** The `--version` run I1 captured. */
  version: Run | null = null
  /** The piped, no-colour output I6 captured. */
  output = ''
  /** Last plain CLI invocation. */
  last: ChildRun = { code: -1, stdout: '', stderr: '' }
}

const shellEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  env.TERM = 'xterm-256color'
  return { ...env, ...extra }
}

/** Boot the isolated environment: temp folder, seeded plan, resolved CLI.
 *  Exported for the smoke test, which proves the harness boots a run and stays
 *  out of the repo without any feature code existing yet. */
export async function boot(s: Session): Promise<void> {
  if (s.booted) return
  const dir = scratch('docnamer-ux')
  s.dir = dir
  s.planPath = `${dir}/${PLAN_FILE}`
  // The plan is written by the PRODUCT's own writer, so review reads a file the
  // product produced, not one this harness hand-rolled from a guessed envelope.
  await writePlan(dir, seedRows())
  s.cli = await resolveCli()
  s.booted = true
}

const missingCli = (): Error =>
  new Error(
    'docnamer CLI absent: the program under test is not built yet, so this flow is red for the right reason. Set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts'
  )

/** Boot if a prior step has not, and prove a CLI is reachable. */
async function ensure(s: Session): Promise<void> {
  if (!s.booted) await boot(s)
  if (!s.cli) throw missingCli()
}

const argv = (s: Session): string[] => {
  if (!s.cli) throw missingCli()
  return s.cli
}

/** Spawn `cmd` on its own pty and collect every byte it writes. A wait answers
 *  the keys typed last: it reads only what was written after them, because a
 *  marker already on screen before the keys proves nothing about what they did
 *  — the scrolled review frame was captured before any redraw that way, byte
 *  for byte the frame before it. */
function startPty(cmd: string[], env: Record<string, string>, cwd: string): Live {
  const term = makeTerminal()
  const proc = Bun.spawn(cmd, { terminal: term.terminal, env, cwd })
  let mark = 0
  const since = (): string => term.read().slice(mark).replace(ANSI, '')
  const waitFor = async (marker: string, ms = 20000): Promise<void> => {
    const start = Date.now()
    for (;;) {
      if (since().includes(marker)) return
      if (Date.now() - start > ms) {
        throw new Error(
          `the terminal never showed ${JSON.stringify(marker)}: it showed ${JSON.stringify(
            since().slice(-500)
          )}`
        )
      }
      await Bun.sleep(25)
    }
  }
  const waitForScreen = async (state: string, ms = 20000): Promise<string> => {
    const start = Date.now()
    for (;;) {
      const screen = await term.screen()
      if (screen.includes(state)) return screen
      if (Date.now() - start > ms) {
        throw new Error(`the screen never showed ${JSON.stringify(state)}; it showed:\n${screen}`)
      }
      await Bun.sleep(25)
    }
  }
  return {
    term,
    proc,
    write: (keys: string) => {
      mark = term.read().length
      term.terminal.write(keys)
    },
    reset: () => {
      mark = 0
      term.reset()
    },
    waitFor,
    waitForScreen,
    seen: () => term.read(),
    screen: () => term.screen(),
    finish: async (ms = 20000): Promise<Run> => {
      const raced = await Promise.race([proc.exited, Bun.sleep(ms).then(() => 'hung' as const)])
      if (raced === 'hung') {
        proc.kill()
        return { exited: false, code: null, output: term.read() }
      }
      await Bun.sleep(150)
      return { exited: true, code: raced, output: term.read() }
    },
    close: () => term.terminal.close()
  }
}

/** Remove the frames one flow wrote on an earlier run, so the judge never reads
 *  a frame this run did not draw. Only this flow's: the flows run side by side,
 *  and another flow's frames are its own. */
function clearFrames(flow: string): void {
  const dir = `${repo}/${FRAMES_DIR}`
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names)
    if (name.startsWith(`${flow}-`)) rmSync(`${dir}/${name}`, { force: true })
}

/** The plain text of a captured frame, escapes removed. */
const strip = (text: string): string => text.replace(ANSI, '')

// --- I1: version command leaves a clean terminal ------------------------------

/** run_version: run `docnamer --version` under zsh on a real pty. The stray `%`
 *  zsh prints comes from the wrapper's raw-mode tty losing the trailing CRLF, so
 *  the wrapper — not the bare binary — is what this drives. */
export async function run_version(s: Session): Promise<Session> {
  await ensure(s)
  clearFrames('i1')
  if (!(await Bun.file(wrapper).exists())) {
    throw new Skipped(`I1 run_version: no installed wrapper at ${wrapper} to drive`)
  }
  const live = startPty(['/bin/zsh', '-f'], shellEnv({ PS1: 'ux-ready> ' }), s.dir)
  s.shell = live
  await live.waitFor('ux-ready>', 10000)
  live.reset()
  live.write(`${wrapper} --version\r`)
  await live.waitFor('ux-ready>', 30000)
  s.version = { exited: true, code: 0, output: live.seen() }
  return s
}

/** capture_pty_frame: write the captured version frame as the flow's evidence. */
export async function capture_pty_frame(s: Session): Promise<Session> {
  if (!s.version) throw new Error('I1 capture_pty_frame: run_version has not run')
  if (!s.shell) throw new Error('I1 capture_pty_frame: run_version left no shell session')
  // The screen, not the byte log: the log carries every redraw and erase, which
  // rasterises as mangled, over-wide lines no judge can read.
  s.versionFrame = await s.shell.screen()
  await frame(s.versionFrame, 'i1-version')
  return s
}

/** version_frame_legible: the evidence is the screen a person saw — the version
 *  on a line of its own, not the byte log where the command echo and the output
 *  collide (`--versiondocnamer 0.1.0`). A frame a judge cannot read is no frame. */
export async function version_frame_legible(s: Session): Promise<Session> {
  const lines = s.versionFrame.split('\n')
  const long = lines.find(l => l.length > 100)
  if (long !== undefined) {
    throw new Error(
      `I1 version_frame_legible: a line runs ${long.length} chars — wider than the 100-column screen, so this is the byte log's redraws, not what a person saw:\n${long}`
    )
  }
  if (!lines.some(l => /^docnamer \d+\.\d+\.\d+$/.test(l.trim()))) {
    throw new Error(`I1 version_frame_legible: no line holds the version alone:\n${s.versionFrame}`)
  }
  return s
}

/** no_stray_percent: no `%` marker sits between the version line and the prompt.
 *  Asserted on the SCREEN, not the byte log: zsh prints its promptsp `%` plus
 *  erase after every command, so the byte log always carries it — only the
 *  screen shows whether the erase overwrote it (clean CRLF) or it stands
 *  mid-line (a wrapper that lost the CR). */
export async function no_stray_percent(s: Session): Promise<Session> {
  if (!s.version) throw new Error('I1 no_stray_percent: run_version has not run')
  if (!s.shell) throw new Error('I1 no_stray_percent: run_version left no shell')
  const screen = await s.shell.screen()
  const version = `docnamer ${referenceOutput()}`
  if (!screen.includes(version)) {
    throw new Error(`I1 no_stray_percent: the screen carries no ${version} line:\n${screen}`)
  }
  const afterVersion = screen.slice(screen.indexOf(version))
  if (afterVersion.includes('%')) {
    throw new Error(`I1 no_stray_percent: a stray % stands on screen after the version:\n${screen}`)
  }
  return s
}

/** prompt_on_own_line: the shell prompt returns on the line after the version. */
export async function prompt_on_own_line(s: Session): Promise<Session> {
  if (!s.version) throw new Error('I1 prompt_on_own_line: run_version has not run')
  const lines = strip(s.version.output).split(/\r\n|\n|\r/)
  const version = lines.findIndex(l => VERSION_LINE.test(l))
  if (version < 0) throw new Error('I1 prompt_on_own_line: the frame carries no version line')
  const promptAfter = lines.slice(version + 1).some(l => l.includes('ux-ready>'))
  if (!promptAfter) {
    throw new Error(
      `I1 prompt_on_own_line: the prompt did not return on its own line after the version:\n${lines.join('\n')}`
    )
  }
  return s
}

// --- I2: review screen shows padded cards with a locked controls header -------

/** open_review: start `docnamer review` on a pty and wait for the header. */
export async function open_review(s: Session): Promise<Session> {
  await ensure(s)
  const live = startPty([...argv(s), 'review', s.dir], shellEnv(), repo)
  s.review = live
  await live.waitFor('Reviewing', 30000)
  return s
}

/** render_cards: wait until the screen shows the first two cards, and capture it. */
export async function render_cards(s: Session): Promise<Session> {
  clearFrames('i2')
  const live = await reviewOf(s)
  s.reviewFrame = await live.waitForScreen('[2/3]', 30000)
  await frame(s.reviewFrame, 'i2-review')
  return s
}

/** review_frame_captured: the review flow leaves visual evidence — a rasterised
 *  frame a judge can read the cards, the padding and the controls header off.
 *  The judge reads every .png under .audit/screenshots/, so a flow that writes
 *  none fails its elements sight unseen. */
export async function review_frame_captured(s: Session): Promise<Session> {
  const png = `${repo}/${FRAMES_DIR}/i2-review.png`
  if (!(await Bun.file(png).exists())) {
    throw new Error(`I2 review_frame_captured: render_cards wrote no frame to ${png}`)
  }
  if (!/\[\d+\/\d+\]/.test(strip(s.reviewFrame))) {
    throw new Error(`I2 review_frame_captured: the frame shows no [n/m] card:\n${s.reviewFrame}`)
  }
  return s
}

/** two_cards_with_padding: at least two cards, with a blank line between them. */
export async function two_cards_with_padding(s: Session): Promise<Session> {
  const lines = strip(s.reviewFrame).split(/\r\n|\n|\r/)
  const headers = lines.reduce<number[]>((at, l, i) => {
    if (/\[\d+\/\d+\]/.test(l)) at.push(i)
    return at
  }, [])
  if (headers.length < 2) {
    throw new Error(
      `I2 two_cards_with_padding: ${headers.length} card(s) on screen:\n${s.reviewFrame}`
    )
  }
  const between = lines.slice((headers[0] as number) + 1, headers[1] as number)
  if (!between.some(l => l.trim() === '')) {
    throw new Error(
      `I2 two_cards_with_padding: no blank padding line between the first two cards:\n${between.join('\n')}`
    )
  }
  return s
}

/** scroll_down: move the cursor to the next document, and capture the screen
 *  once it shows the move — the header naming document 2, not a frame that was
 *  already there before the key. */
export async function scroll_down(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  const before = s.reviewFrame
  live.write('\x1b[B')
  s.reviewFrame = await live.waitForScreen('Reviewing document 2 of 3', 30000)
  if (s.reviewFrame === before) {
    throw new Error(`I2 scroll_down: the screen did not change after the move:\n${before}`)
  }
  await frame(s.reviewFrame, 'i2-review-scrolled')
  return s
}

/** title_rule_fits_screen: the divider under the review title fits the screen.
 *  The title carries the plan path, so it is clipped; a rule drawn to the title's
 *  full length runs past the edge into the truncation marker. */
export async function title_rule_fits_screen(s: Session): Promise<Session> {
  const lines = strip(s.reviewFrame).split(/\r\n|\n|\r/)
  const rule = lines.find(l => /^[\s]*[\u2500-\u257f]{4,}/.test(l))
  if (rule === undefined) {
    throw new Error(
      `I2 title_rule_fits_screen: the frame shows no rule under the title:\n${s.reviewFrame}`
    )
  }
  if (rule.includes('...')) {
    throw new Error(
      `I2 title_rule_fits_screen: the rule was drawn to the title's full length and clipped at the screen edge:\n${rule}`
    )
  }
  if (rule.length > SCREEN_COLS) {
    throw new Error(
      `I2 title_rule_fits_screen: the rule is ${rule.length} cells wide on a ${SCREEN_COLS}-column screen:\n${rule}`
    )
  }
  return s
}

/** header_still_visible: the controls header survives the scroll. */
export async function header_still_visible(s: Session): Promise<Session> {
  if (!CONTROLS.test(strip(s.reviewFrame))) {
    throw new Error(`I2 header_still_visible: the controls header scrolled away:\n${s.reviewFrame}`)
  }
  if (!(await Bun.file(`${repo}/${FRAMES_DIR}/i2-review-scrolled.png`).exists())) {
    throw new Error(
      'I2 header_still_visible: scroll_down wrote no frame to show the header survived'
    )
  }
  return s
}

/** The review session, opened on demand so I3's steps stand alone. */
async function reviewOf(s: Session): Promise<Live> {
  if (s.review) return s.review
  await open_review(s)
  if (!s.review) throw new Error('I2 reviewOf: open_review left no session')
  return s.review
}

// --- I3: revisit and change an already-assessed document ----------------------

/** accept_doc1: accept document 1, then move on. Each I3 step leaves the
 *  screen it produced as a frame, so the judge can follow the edit flow. */
export async function accept_doc1(s: Session): Promise<Session> {
  clearFrames('i3')
  const live = await reviewOf(s)
  await live.waitForScreen('Reviewing document 1 of 3', 30000)
  live.write('\r')
  await frame(await live.waitForScreen('Reviewing document 2 of 3', 30000), 'i3-1-accepted')
  return s
}

/** navigate_back: ↑ returns to the already-accepted document 1. */
export async function navigate_back(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('\x1b[A')
  const screen = await live.waitForScreen('Reviewing document 1 of 3', 30000)
  if (!screen.includes('(accepted)')) {
    throw new Error(`I3 navigate_back: document 1 does not show its decision:\n${screen}`)
  }
  await frame(screen, 'i3-2-back')
  return s
}

/** The name I3 edits document 1 to. */
const EDITED = '2024-03-12 acme receipt revised.pdf'

/** edit_name: `e` opens the name as it stands; Ctrl-U clears it, the new name,
 *  Enter, then quit so the plan is persisted. */
export async function edit_name(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('e')
  await frame(
    await live.waitForScreen('new name: 2024-03-12 acme receipt.pdf', 30000),
    'i3-3-edit-open'
  )
  live.write(`\x15${EDITED}`)
  await frame(await live.waitForScreen(`new name: ${EDITED}`, 30000), 'i3-4-name-typed')
  live.write('\r')
  await live.waitForScreen('Reviewing document 2 of 3', 30000)
  live.write('q')
  const run = await live.finish(30000)
  if (!run.exited || run.code !== 0) {
    throw new Error(
      `I3 edit_name: review did not exit cleanly: ${JSON.stringify(run.output.slice(-400))}`
    )
  }
  await frame(await live.screen(), 'i3-5-saved')
  return s
}

/** plan_updated_for_doc1: the plan on disk records the new name for document 1. */
export async function plan_updated_for_doc1(s: Session): Promise<Session> {
  const rows = JSON.parse(await Bun.file(s.planPath).text()) as PlanRow[]
  const first = rows[0]
  if (!first) throw new Error('I3 plan_updated_for_doc1: the plan has no first row')
  if (first.new !== '2024-03-12 acme receipt revised.pdf') {
    throw new Error(`I3 plan_updated_for_doc1: document 1 is "${first.new}", not the edited name`)
  }
  if (first.status !== 'accepted') {
    throw new Error(`I3 plan_updated_for_doc1: document 1 is ${first.status}, not accepted`)
  }
  // The plan file is what the interaction changes, and nothing on the screen
  // shows it: its rows go into a frame of their own, as the file holds them.
  const record = rows.map(r => `${r.status.padEnd(9)} ${r.old.padEnd(14)} -> ${r.new}`)
  await frame([`${s.planPath}:`, '', ...record].join('\n'), 'i3-6-plan-file')
  return s
}

/** later_docs_unchanged: documents 2 and 3 keep their prior state. */
export async function later_docs_unchanged(s: Session): Promise<Session> {
  const rows = JSON.parse(await Bun.file(s.planPath).text()) as PlanRow[]
  for (const row of rows.slice(1)) {
    if (
      row.new !== '2024-03-13 globex receipt.pdf' &&
      row.new !== '2024-03-14 initech receipt.pdf'
    ) {
      throw new Error(`I3 later_docs_unchanged: later document ${row.old} became "${row.new}"`)
    }
    if (row.status !== 'pending') {
      throw new Error(`I3 later_docs_unchanged: later document ${row.old} is ${row.status}`)
    }
  }
  return s
}

// --- I4: block progress bar next to the throbber during analysis --------------

/** Documents for an analysis to work through, so its in-progress frames exist: the boot folder holds
 *  only a plan, and planning it finishes at once (`planned 0 document(s)`) with no frame to observe.
 *  Text, an OCR'd scan and an image finish at different times — three text files finish inside one
 *  80 ms paint and the bar never draws between 0% and 100%. Copied from tests/fixtures as the pipeline
 *  harness copies them. */
const ANALYSED = ['statement-text.pdf', 'dup-invoice.txt', 'acme-statement-scan.pdf', 'receipt.png']
async function analysisDir(s: Session): Promise<string> {
  if (s.analysisDir !== '') return s.analysisDir
  const dir = scratch('docnamer-analysis')
  for (const name of ANALYSED) {
    await Bun.write(
      `${dir}/${name}`,
      await Bun.file(`${repo}/tests/fixtures/${name}`).arrayBuffer()
    )
  }
  s.analysisDir = dir
  return dir
}

/** start_analysis: run `docnamer plan` on a pty and wait for the throbber. */
export async function start_analysis(s: Session): Promise<Session> {
  await ensure(s)
  await ensureProviderKey()
  const live = startPty([...argv(s), 'plan', await analysisDir(s)], shellEnv(), repo)
  s.analysis = live
  await live.waitFor('reading', MODEL_CALL_MS)
  return s
}

/** A missing bar fails inside the red gate's verdict budget: the first
 *  throbber frame either carries the bar or never will, so the wait covers a
 *  few frames, not the model call. */
const BAR_WINDOW_MS = 5_000

/** throbber_with_bar: a `▰`/`▱` bar followed by a percentage sits beside it. */
export async function throbber_with_bar(s: Session): Promise<Session> {
  clearFrames('i4')
  const live = await analysisOf(s)
  const full = referenceFullBlock()
  await live.waitFor(full, BAR_WINDOW_MS)
  // The throbber frame is transient — gone once the run completes — so the
  // evidence screen is taken here, while the bar is provably on it.
  s.throbberFrame = await live.screen()
  const text = strip(live.seen())
  const pct = text.search(/\d+%/)
  if (!text.includes(full) || pct === -1 || text.indexOf(full) > pct) {
    throw new Error(`I4 throbber_with_bar: no ${full} bar with a percentage in the frame:\n${text}`)
  }
  return s
}

/** capture_frames: collect the successive distinct frames the analysis drew. */
export async function capture_frames(s: Session): Promise<Session> {
  const live = await analysisOf(s)
  const deadline = Date.now() + MODEL_CALL_MS
  let last = ''
  while (Date.now() < deadline && live.proc.exitCode === null) {
    const text = strip(live.seen())
    if (text !== last) {
      s.analysisFrames.push(text)
      last = text
    }
    await Bun.sleep(100)
  }
  // The frame the terminal holds at exit — the completion line — is drawn after the last poll.
  const final = strip(live.seen())
  if (final !== last) s.analysisFrames.push(final)
  if (s.analysisFrames.length === 0) {
    throw new Error('I4 capture_frames: the analysis drew no frame to capture')
  }
  if (!s.throbberFrame) throw new Error('I4 capture_frames: throbber_with_bar has not run')
  s.framedAnalysis = s.throbberFrame
  await frame(s.framedAnalysis, 'i4-analysis')
  return s
}

/** analysis_frame_is_one_screen: the evidence is one screen — what a person saw
 *  while the bar climbed — not the concatenation of every redraw the pty ever
 *  received, which rasterises as hundreds of lines of history no judge can read. */
export async function analysis_frame_is_one_screen(s: Session): Promise<Session> {
  const lines = s.framedAnalysis.split('\n')
  if (lines.length > 60) {
    throw new Error(
      `I4 analysis_frame_is_one_screen: the frame is ${lines.length} lines of redraw history, not one screen`
    )
  }
  const long = lines.find(l => l.length > 100)
  if (long !== undefined) {
    throw new Error(
      `I4 analysis_frame_is_one_screen: a line runs ${long.length} chars — wider than the 100-column screen, so this is the byte log's redraws, not one screen`
    )
  }
  if (!s.framedAnalysis.includes(referenceFullBlock()) || !/\d+%/.test(s.framedAnalysis)) {
    throw new Error(
      `I4 analysis_frame_is_one_screen: the frame shows no bar with a percentage:\n${s.framedAnalysis}`
    )
  }
  return s
}

/** percentage_increases: the percentage rises, never falls, as documents finish. */
export async function percentage_increases(s: Session): Promise<Session> {
  // A frame is everything the terminal received so far (pty `read()`), so the last one holds every
  // paint in order; reading each frame would count the earlier paints again and see the bar fall.
  const seen = [...(s.analysisFrames.at(-1) ?? '').matchAll(/(\d+)%/g)].map(m => Number(m[1]))
  if (seen.length < 2) {
    throw new Error(`I4 percentage_increases: only ${seen.length} percentage(s) were drawn`)
  }
  for (let i = 1; i < seen.length; i += 1) {
    if ((seen[i] as number) < (seen[i - 1] as number)) {
      throw new Error(`I4 percentage_increases: ${seen[i - 1]}% fell to ${seen[i]}%`)
    }
  }
  if ((seen[seen.length - 1] as number) <= (seen[0] as number)) {
    throw new Error(`I4 percentage_increases: the percentage never rose from ${seen[0]}%`)
  }
  return s
}

/** The analysis session, opened on demand so I5's steps stand alone. */
async function analysisOf(s: Session): Promise<Live> {
  if (s.analysis) return s.analysis
  await start_analysis(s)
  if (!s.analysis) throw new Error('I4 analysisOf: start_analysis left no session')
  return s.analysis
}

// --- I5: completion status uses the same block bar ----------------------------

/** analysis_completes: wait for the analysis to exit cleanly. */
export async function analysis_completes(s: Session): Promise<Session> {
  clearFrames('i5')
  const live = await analysisOf(s)
  const run = await live.finish(MODEL_CALL_MS)
  if (!run.exited || run.code !== 0) {
    throw new Error(`I5 analysis_completes: analysis did not finish cleanly: ${run.code}`)
  }
  s.analysisFrames.push(strip(run.output))
  s.completionFrame = await live.screen()
  await frame(s.completionFrame, 'i5-complete')
  return s
}

/** completion_line: the run's last line reports completion in the bar's format. */
export async function completion_line(s: Session): Promise<Session> {
  const last = s.analysisFrames[s.analysisFrames.length - 1]
  if (last === undefined) throw new Error('I5 completion_line: analysis_completes has not run')
  if (!/\d+%/.test(last)) {
    throw new Error(`I5 completion_line: no completion line with a percentage:\n${last}`)
  }
  return s
}

/** full_bar_100_percent: the completion line shows the full ten-block bar. */
export async function full_bar_100_percent(s: Session): Promise<Session> {
  const last = s.analysisFrames[s.analysisFrames.length - 1]
  if (last === undefined) throw new Error('I5 full_bar_100_percent: analysis_completes has not run')
  const expected = referenceFullBar()
  if (!last.includes(expected)) {
    throw new Error(`I5 full_bar_100_percent: the completion line is not ${expected}:\n${last}`)
  }
  // The element is judged off a frame, not a byte log: the run's own screen must
  // carry the bar, and the PNG that shows it must exist.
  if (!s.completionFrame.includes(expected)) {
    throw new Error(
      `I5 full_bar_100_percent: the completion screen does not show ${expected}:\n${s.completionFrame}`
    )
  }
  if (!(await Bun.file(`${repo}/${FRAMES_DIR}/i5-complete.png`).exists())) {
    throw new Error('I5 full_bar_100_percent: analysis_completes wrote no completion frame')
  }
  return s
}

// --- I6: ASCII and no-colour fallback -----------------------------------------

/** run_with_no_color_piped: run the CLI piped, with NO_COLOR set. */
export async function run_with_no_color_piped(s: Session): Promise<Session> {
  await ensure(s)
  clearFrames('i6')
  await ensureProviderKey()
  const res = await runChild([...argv(s), 'plan', await analysisDir(s)], {
    cwd: repo,
    env: { ...shellEnv({ NO_COLOR: '1' }) },
    timeoutMs: MODEL_CALL_MS
  })
  s.last = res
  s.output = res.stdout + res.stderr
  if (s.output.trim() === '') throw new Error('I6 run_with_no_color_piped: the run wrote nothing')
  return s
}

/** capture_output: write the piped output as the flow's evidence, under the
 *  command that produced it. A pipe has no screen and so no width: its table is
 *  whole where a 100-column screen's gives way, and a judge comparing the two
 *  frames has to be able to see which is which. */
export async function capture_output(s: Session): Promise<Session> {
  await frame(`$ NO_COLOR=1 docnamer plan ${s.analysisDir} | cat\n${s.output}`, 'i6-no-colour')
  return s
}

/** no_ansi_escapes: not one escape sequence reaches the pipe. */
export async function no_ansi_escapes(s: Session): Promise<Session> {
  const found = s.output.match(ANSI)
  if (found) {
    throw new Error(
      `I6 no_ansi_escapes: piped output carries the escape ${JSON.stringify(found[0])}`
    )
  }
  return s
}

/** ascii_progress_shown: no unicode glyph, and ASCII progress instead. */
export async function ascii_progress_shown(s: Session): Promise<Session> {
  if (BLOCKS.test(s.output)) {
    throw new Error('I6 ascii_progress_shown: piped output carries a unicode block or rule glyph')
  }
  if (!/[#=>-]|%/.test(s.output)) {
    throw new Error(`I6 ascii_progress_shown: no ASCII progress in the output:\n${s.output}`)
  }
  return s
}
