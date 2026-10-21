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
import { frame, FRAMES_DIR } from './frame.ts'
import { ANSI, makeTerminal, type Run, type Term } from './pty.ts'
import { ensureProviderKey, MODEL_CALL_MS } from './preload.ts'
import { scratch } from './scratch.ts'

/** Repo root, so a spec can read the tree this run belongs to. */
export const repo = import.meta.dir.replace(/\/tests$/, '')

/** A named hole: the claim cannot be closed on the current observation surface. */
export class Skipped extends Error {
  readonly skip = true
  constructor(readonly claim: string) {
    super('SKIP: ' + claim)
    this.name = 'Skipped'
  }
}

/** The version line the wrapper prints, read off a captured frame. */
export const VERSION_LINE = /^docnamer\s+\S+/m

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
export const BLOCKS = /[\u25b0\u25b1\u2500-\u257f]/

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
  write(keys: string): void
  reset(): void
  waitFor(marker: string, ms?: number): Promise<void>
  seen(): string
  screen(): string
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

/** Spawn `cmd` on its own pty and collect every byte it writes. */
function startPty(cmd: string[], env: Record<string, string>, cwd: string): Live {
  const term = makeTerminal()
  const proc = Bun.spawn(cmd, { terminal: term.terminal, env, cwd })
  const plain = (): string => term.read().replace(ANSI, '')
  const waitFor = async (marker: string, ms = 20000): Promise<void> => {
    const start = Date.now()
    for (;;) {
      if (plain().includes(marker)) return
      if (Date.now() - start > ms) {
        throw new Error(
          `the terminal never showed ${JSON.stringify(marker)}: it showed ${JSON.stringify(
            plain().slice(-500)
          )}`
        )
      }
      await Bun.sleep(25)
    }
  }
  return {
    term,
    proc,
    write: (keys: string) => term.terminal.write(keys),
    reset: () => term.reset(),
    waitFor,
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

/** The plain text of a captured frame, escapes removed. */
const strip = (text: string): string => text.replace(ANSI, '')

// --- I1: version command leaves a clean terminal ------------------------------

/** run_version: run `docnamer --version` under zsh on a real pty. The stray `%`
 *  zsh prints comes from the wrapper's raw-mode tty losing the trailing CRLF, so
 *  the wrapper — not the bare binary — is what this drives. */
export async function run_version(s: Session): Promise<Session> {
  await ensure(s)
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
  s.versionFrame = s.shell.screen()
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
  const screen = s.shell.screen()
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

/** render_cards: wait for the first card and capture the frame. */
export async function render_cards(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  await live.waitFor('[1/', 30000)
  s.reviewFrame = live.screen()
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

/** scroll_down: move the cursor to the next document. */
export async function scroll_down(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('\x1b[B')
  await live.waitFor('[2/', 30000)
  s.reviewFrame = live.screen()
  return s
}

/** header_still_visible: the controls header survives the scroll. */
export async function header_still_visible(s: Session): Promise<Session> {
  if (!CONTROLS.test(strip(s.reviewFrame))) {
    throw new Error(`I2 header_still_visible: the controls header scrolled away:\n${s.reviewFrame}`)
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

/** accept_doc1: accept document 1, then move on. */
export async function accept_doc1(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('\r')
  await live.waitFor('[2/', 30000)
  return s
}

/** navigate_back: ↑ returns to the already-accepted document 1. */
export async function navigate_back(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('\x1b[A')
  await live.waitFor('[1/', 30000)
  return s
}

/** edit_name: `e`, the new name, Enter, then quit so the plan is persisted. */
export async function edit_name(s: Session): Promise<Session> {
  const live = await reviewOf(s)
  live.write('e')
  await live.waitFor('new name', 30000)
  live.write('2024-03-12 acme receipt revised.pdf\r')
  await live.waitFor('[2/', 30000)
  live.write('q')
  const run = await live.finish(30000)
  if (!run.exited || run.code !== 0) {
    throw new Error(
      `I3 edit_name: review did not exit cleanly: ${JSON.stringify(run.output.slice(-400))}`
    )
  }
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
  const live = await analysisOf(s)
  const full = referenceFullBlock()
  await live.waitFor(full, BAR_WINDOW_MS)
  // The throbber frame is transient — gone once the run completes — so the
  // evidence screen is taken here, while the bar is provably on it.
  s.throbberFrame = live.screen()
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
  const live = await analysisOf(s)
  const run = await live.finish(MODEL_CALL_MS)
  if (!run.exited || run.code !== 0) {
    throw new Error(`I5 analysis_completes: analysis did not finish cleanly: ${run.code}`)
  }
  s.analysisFrames.push(strip(run.output))
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
  return s
}

// --- I6: ASCII and no-colour fallback -----------------------------------------

/** run_with_no_color_piped: run the CLI piped, with NO_COLOR set. */
export async function run_with_no_color_piped(s: Session): Promise<Session> {
  await ensure(s)
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

/** capture_output: write the piped output as the flow's evidence. */
export async function capture_output(s: Session): Promise<Session> {
  await frame(s.output, 'i6-no-colour')
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
