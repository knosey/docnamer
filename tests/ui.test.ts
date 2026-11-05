/**
 * The presentation layer (src/ui.ts) — the one owner of every byte docnamer
 * writes.
 *
 * These are pure-layout assertions, not a screen: every function returns the
 * string the CLI will print, so the effect under test is the exact text a
 * person reads, with no terminal in between. The wiring (which stream, which
 * exit code) is driven for real by tests/cli-help.test.ts and the flow
 * harnesses.
 *
 * Three contracts here are load-bearing for OTHER suites and are pinned on
 * purpose:
 *
 *  1. The plan table's margin. tests/doc-renamer-pipeline-harness.ts asserts
 *     `line.startsWith('!')`, so the margin is never wrapped in an escape
 *     sequence — colour starts after it.
 *  2. No escape sequences at all when colour is off. The frames the visual
 *     judge reads are rasterised from PIPED stdout (tests/frame.ts), and a
 *     stray ANSI code in that text is a corruption of the evidence, not a
 *     cosmetic detail.
 *  3. The ASCII fallback. `TERM=dumb` and a non-UTF-8 locale must produce a
 *     frame a terminal can actually draw, not mojibake.
 */
// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? "locale charmap"

import { expect, test } from "bun:test"
import { styleFrom, ui, type Style } from "../src/ui.ts"
import { runChild } from "./child.ts"
import { resolveCli } from "./doc-renamer-apply-harness.ts"
import { scratch } from "./scratch.ts"

const PLAIN: Style = { colour: false, unicode: false, tty: false }
const PRETTY: Style = { colour: true, unicode: true, tty: true }

const ANSI = String.fromCharCode(27) + "["
const GAP = "  "

test("a pipe gets unicode glyphs but no colour", () => {
  const style = styleFrom({}, false)
  expect(style.unicode, "a piped run must still be able to print the glyph set").toBe(true)
  expect(style.colour, "a piped run must not write escape sequences into its stdout").toBe(false)
})

test("a terminal gets colour, unless NO_COLOR says otherwise", () => {
  expect(styleFrom({}, true).colour, "an interactive run should be coloured").toBe(true)
  expect(styleFrom({ NO_COLOR: "1" }, true).colour, "NO_COLOR was ignored").toBe(false)
  expect(
    styleFrom({ NO_COLOR: "" }, true).colour,
    "NO_COLOR is a presence check, not a value"
  ).toBe(false)
})

test("a terminal that cannot draw the glyph set gets ASCII instead", () => {
  expect(styleFrom({ TERM: "dumb" }, true).unicode, "TERM=dumb must fall back to ASCII").toBe(false)
  expect(styleFrom({ LANG: "C" }, true).unicode, "a non-UTF-8 locale must fall back to ASCII").toBe(
    false
  )
  expect(
    styleFrom({ LANG: "en_US.UTF-8" }, true).unicode,
    "a UTF-8 locale must keep the glyph set"
  ).toBe(true)
  expect(
    styleFrom({ LC_ALL: "C", LANG: "en_US.UTF-8" }, true).unicode,
    "LC_ALL overrides LANG, so this is an ASCII terminal"
  ).toBe(false)
})

test("colour off means not one escape sequence anywhere in the output", () => {
  const u = ui(PLAIN)
  const text = [
    u.head("Plan", "./scans"),
    u.table(["FILE", "NEW NAME"], [["a.pdf", "2024 Acme.pdf"]]),
    u.note("nothing was renamed"),
    u.ok("planned 2 document(s)"),
    u.warn("1 row needs a decision"),
    u.fail("unknown provider `nope`", "run `docnamer login` to list them")
  ].join("\n")
  expect(text, `colour is off, so this text must be plain:\n${text}`).not.toContain(ANSI)
})

test('the plan margin stays raw so a colour terminal cannot hide the "!"', () => {
  const line = ui(PRETTY).row("!", [
    "invoice-001.pdf",
    "2024-03-11 Acme - Invoice 1042.pdf",
    "invoice"
  ])
  expect(
    line.startsWith("!"),
    `a flagged row must begin with its margin, whatever the styling:\n${JSON.stringify(line)}`
  ).toBe(true)
  const plain = ui(PLAIN).row(" ", [
    "invoice-001.pdf",
    "2024-03-11 Acme - Invoice 1042.pdf",
    "invoice"
  ])
  expect(plain.startsWith("!"), "an unflagged row must not be marked").toBe(false)
})

test("a table aligns its columns and never leaves trailing whitespace", () => {
  const text = ui(PLAIN).table(
    ["FILE", "NEW NAME"],
    [
      ["a.pdf", "short.pdf"],
      ["a-very-long-name.pdf", "b.pdf"]
    ]
  )
  const lines = text.split("\n")
  for (const line of lines) {
    expect(line, `a table line ends in whitespace:\n${JSON.stringify(line)}`).toBe(line.trimEnd())
  }
  // The second column begins at ONE offset on every line. Slicing all three at
  // the same index and getting exactly the right cell is the alignment; the
  // column is padded to its widest cell, not to the header.
  const start = 2 + "a-very-long-name.pdf".length + 2
  const second = (line: string): string => (line as string).slice(start).trim()
  expect(second(lines[0] as string), "the header did not take the second column offset").toBe(
    "NEW NAME"
  )
  expect(second(lines[2] as string), "the first row did not take the second column offset").toBe(
    "short.pdf"
  )
  expect(second(lines[3] as string), "the second row did not take the second column offset").toBe(
    "b.pdf"
  )
  const rule = lines[1] as string
  const runs = rule.trim().split(GAP)
  expect(runs.length, "the rule must span both columns, not just the first").toBe(2)
  for (const run of runs) {
    expect(run, `a column rule is not a single repeated glyph: ${JSON.stringify(run)}`).toMatch(
      /^([^\w\s])\1*$/
    )
  }
})

test("a failure block names what broke and how to fix it", () => {
  const text = ui(PLAIN).fail("unknown provider `nope`", "run `docnamer login` to list them")
  const lines = text.split("\n")
  expect(lines[0], "a failure must name the program that is speaking").toContain("docnamer:")
  expect(lines[0], "a failure must name the thing that failed").toContain("nope")
  expect(lines[1], "a failure must carry the fix on its own line").toContain("help:")
  expect(lines[1], "the fix line must name the command that resolves it").toContain(
    "docnamer login"
  )
})

test("a failure with no fix prints one line, not an empty help", () => {
  const text = ui(PLAIN).fail("could not read ./scans")
  expect(text.split("\n").length, `an absent fix must not leave a blank line:\n${text}`).toBe(1)
  expect(text, "the message was dropped").toContain("could not read ./scans")
})

test("a spinner on a pipe logs its label once and never redraws", () => {
  const seen: string[] = []
  const real = process.stdout.write.bind(process.stdout)
  // The spinner's whole observable effect is what it writes. Capture it rather
  // than reading the terminal, which is the thing that is not there. The
  // spinner logs at construction, so it has to be built inside the capture.
  process.stdout.write = ((chunk: string) => {
    seen.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    const s = ui(PLAIN).spinner("reading 12 document(s)")
    s.update("reading 12 document(s) (4s)")
    s.stop("reviewed 12 document(s)")
  } finally {
    process.stdout.write = real
  }
  const out = seen.join("")
  const logged = out.split("reading 12 document(s)").length - 1
  expect(logged, "a piped run must log what it is doing exactly once, not per update").toBe(1)
  expect(out, "a piped spinner never reported its result").toContain("reviewed 12 document(s)")
  expect(out, "a piped spinner must not emit a redraw").not.toContain("\r")
})

test("a spinner on a terminal redraws in place and clears its own line", () => {
  const u = ui(PRETTY)
  const s = u.spinner("reading")
  const seen: string[] = []
  const real = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    seen.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    s.update("reading 1")
    s.stop("done")
  } finally {
    process.stdout.write = real
  }
  const out = seen.join("")
  expect(out, "a terminal spinner must return to the start of its line").toContain("\r")
  expect(out, "a terminal spinner must erase what it drew").toContain(String.fromCharCode(27))
})

/**
 * T2 — the block progress bar and its ASCII fallback.
 *
 * The reference is `locale charmap`: it prints the encoding this locale uses,
 * and that is the truth about whether the block glyphs are drawable. On this
 * machine it prints `UTF-8`, so the unicode style draws the block bar and the
 * ASCII style must not. The completion bar the analysis flow asserts
 * (tests/terminal-ux-polish-harness.ts FULL_BAR) is ten `▰` blocks, a space and
 * `100%`; that is the format this bar must produce.
 */
/** Run the reference command and return its trimmed stdout. */
const referenceOutput = (): string => {
  const [cmd, ...args] = reference.split(/\s+/).filter(Boolean)
  const proc = Bun.spawnSync([cmd as string, ...args])
  return proc.stdout.toString().trim()
}

const FULL_BAR = "\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0\u25b0 100%"
const BLOCK_OR_RULE = /[\u25b0\u25b1\u2500-\u257f]/

/** src/ui.ts after T2, read through the namespace so a missing export is a
 *  failed check this suite prints, never an uncaught throw at load. */
type Progress = { progressBar?: (done: number, total: number, style: Style) => string }
const uiModule = async (): Promise<Progress> =>
  (await import("../src/ui.ts")) as unknown as Progress

const needProgressBar = async (): Promise<((d: number, t: number, s: Style) => string) | null> => {
  const mod = await uiModule()
  expect(typeof mod.progressBar, "src/ui.ts must export progressBar").toBe("function")
  return typeof mod.progressBar === "function" ? mod.progressBar : null
}

test("the block bar follows the locale charmap", () => {
  const charmap = referenceOutput()
  expect(charmap, "the reference locale must be UTF-8").toBe("UTF-8")
  const glyphs = ui(PRETTY).glyphs as unknown as { full?: string; empty?: string }
  expect(glyphs.full, "a UTF-8 locale gets the full block glyph").toBe("\u25b0")
  expect(glyphs.empty, "a UTF-8 locale gets the empty block glyph").toBe("\u25b1")
})

test("a completed run draws the full ten-block bar", async () => {
  const progressBar = await needProgressBar()
  if (!progressBar) return
  expect(progressBar(10, 10, PRETTY), "100% is the full bar the flow asserts").toBe(FULL_BAR)
})

test("a half-finished run fills half the bar", async () => {
  const progressBar = await needProgressBar()
  if (!progressBar) return
  const bar = progressBar(5, 10, PRETTY)
  expect((bar.match(/\u25b0/g) ?? []).length, "half a ten-cell bar is filled").toBe(5)
  expect((bar.match(/\u25b1/g) ?? []).length, "half a ten-cell bar is empty").toBe(5)
  expect(bar, "the bar carries its percentage").toContain("50%")
})

test("an ASCII terminal gets an ASCII bar with no block glyph", async () => {
  const progressBar = await needProgressBar()
  if (!progressBar) return
  const bar = progressBar(10, 10, PLAIN)
  expect(bar, "the ASCII fallback must not draw a block or rule glyph").not.toMatch(BLOCK_OR_RULE)
  expect(bar, "the ASCII bar must still show progress").toMatch(/[#=>-]/)
  expect(bar, "the ASCII bar must still show the percentage").toContain("100%")
})

/** The folder name `scratch` minted. Unique, so a hit cannot be some other path. */
function leaf(dir: string): string {
  const name = dir.split("/").pop()
  if (name === undefined || name === "")
    throw new Error(`ui.test: scratch path has no leaf: ${dir}`)
  return name
}

test("plan . names the folder and says it is analysing, before any model reply", async () => {
  const dir = scratch("docnamer-wait")
  const argv = await resolveCli()
  if (argv === null) throw new Error("no docnamer CLI")
  // An empty folder never reaches the model. The spinner is created before plan(),
  // so a pipe still logs the opening label. That label is the wait the person sees.
  const run = await runChild([...argv, "plan", "."], { cwd: dir, timeoutMs: 15000 })
  expect(run.code, run.stderr).toBe(0)
  expect(
    run.stdout,
    "the dot the user typed must not be the folder the spinner names"
  ).not.toContain("reading .")
  expect(run.stdout, "the spinner must name the folder it is reading").toContain(leaf(dir))
  expect(run.stdout.toLowerCase(), "the wait must say it is analysing the documents").toContain(
    "analysing"
  )
})

test("plan reports zero done as soon as the folder is counted", async () => {
  const dir = scratch("docnamer-counted")
  const { plan } = await import("../src/commands.ts")
  const { BUILTIN_CONFIG } = await import("../src/config.ts")
  const seen: number[] = []
  await plan(dir, { recursive: false, applyUnflagged: false }, BUILTIN_CONFIG, done => {
    seen.push(done)
  })
  expect(seen[0], "the bar must be able to draw before any document is read").toBe(0)
})
