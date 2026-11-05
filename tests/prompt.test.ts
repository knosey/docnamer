/**
 * The interactive layer (src/prompt.ts): the provider picker, and the two
 * question shapes a login flow needs.
 *
 * The frame functions are pure and return the lines they would draw, so the
 * layout is asserted directly instead of through a terminal — a pty gives a byte
 * stream, not a screen, and grepping raw redraw bytes is how a working UI gets
 * called broken (`.agents/skills/driving-hard/pty-and-tui.md`, trap 1).
 *
 * The key decoder is pure too, and that is the point: three measured traps live
 * in exactly this code and none of them are visible in a screenshot.
 *
 *  - trap 2, a sequence arrives SPLIT: a lone `ESC` in one read and `[A` in the
 *    next must still be one Up, so the decoder holds a trailing `ESC`.
 *  - trap 3, arrows arrive as SS3 (`ESC O B`) or CSI (`ESC [ B`) depending on the
 *    terminal's cursor-key mode; matching only one silently ignores every arrow.
 *  - trap 10, the mirror: `ESC [ A ESC [ B` may arrive as ONE read, so a chunk is
 *    a queue of keys and never a single key.
 */
import { expect, test } from "bun:test"
import {
  keyDecoder,
  filter,
  nextCursor,
  pickerFrame,
  pick,
  WINDOW,
  type Option
} from "../src/prompt.ts"
import type { Style } from "../src/ui.ts"

const PLAIN: Style = { colour: false, unicode: false, tty: false }
const PRETTY: Style = { colour: true, unicode: true, tty: true }
const ESC = String.fromCharCode(27)
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const OPTIONS: Option[] = [
  { id: "fireworks", label: "Fireworks", detail: "api key", status: "signed in" },
  { id: "anthropic", label: "Anthropic", detail: "oauth" },
  { id: "deepseek", label: "DeepSeek", detail: "api key" },
  { id: "google", label: "Google", detail: "api key" }
]

/** A frame as lines, with the runs a person reads made greppable. */
// 200 cells: wide enough that nothing here is clipped — clipping to a real
// terminal's width is what the pty suite drives the actual binary for.
const lines = (o: Partial<Parameters<typeof pickerFrame>[0]> = {}): string[] =>
  pickerFrame({
    title: "Sign in to a model provider",
    options: OPTIONS,
    cursor: 0,
    query: "",
    style: PLAIN,
    cols: 200,
    ...o
  })

test("the decoder reads CSI and SS3 arrows alike", () => {
  const decode = keyDecoder()
  expect(decode(bytes(`${ESC}[A`)), "CSI up was not read").toEqual([{ type: "up" }])
  expect(
    decode(bytes(`${ESC}OA`)),
    "SS3 up was not read; a terminal in cursor-key mode sends this"
  ).toEqual([{ type: "up" }])
  expect(decode(bytes(`${ESC}[B`)), "CSI down was not read").toEqual([{ type: "down" }])
  expect(decode(bytes(`${ESC}OB`)), "SS3 down was not read").toEqual([{ type: "down" }])
})

test("the decoder re-joins an arrow split across two reads", () => {
  // Measured: ESC and OB arrive as two separate callbacks often enough to
  // matter, and a handler matching only the whole sequence ignores every arrow.
  const decode = keyDecoder()
  expect(decode(bytes(ESC)), "a lone ESC must be held, not guessed at").toEqual([])
  expect(decode(bytes("[A")), "the held ESC was dropped instead of re-joined").toEqual([
    { type: "up" }
  ])
})

test("one read can carry several keys", () => {
  // The mirror of the split: a string sent as one piece may arrive whole.
  const decode = keyDecoder()
  expect(decode(bytes(`${ESC}[A${ESC}[B\r`)), "a chunk must be a queue of keys").toEqual([
    { type: "up" },
    { type: "down" },
    { type: "enter" }
  ])
})

test("the decoder knows enter, cancel, backspace and plain characters", () => {
  const decode = keyDecoder()
  expect(decode(bytes("\r")), "CR is enter").toEqual([{ type: "enter" }])
  expect(decode(bytes("\n")), "LF is enter too").toEqual([{ type: "enter" }])
  expect(decode(bytes(String.fromCharCode(3))), "ctrl-c must cancel").toEqual([{ type: "cancel" }])
  expect(decode(bytes("\x7f")), "delete is backspace").toEqual([{ type: "backspace" }])
  expect(decode(bytes("fire")), "typed characters were lost").toEqual([
    { type: "char", char: "f" },
    { type: "char", char: "i" },
    { type: "char", char: "r" },
    { type: "char", char: "e" }
  ])
})

test("a control byte never becomes filter text", () => {
  const decode = keyDecoder()
  expect(decode(bytes("\u0004")), "ctrl-d ends the answer, it does not filter by EOT").toEqual([
    { type: "cancel" }
  ])
  expect(decode(bytes("\u0007")), "a bell is not a character to filter by").toEqual([])
  expect(decode(bytes("a\u0007b")), "a control byte between characters is dropped").toEqual([
    { type: "char", char: "a" },
    { type: "char", char: "b" }
  ])
})

test("a held ESC resolves to a cancel once the next read is not an arrow", () => {
  const decode = keyDecoder()
  decode(bytes(ESC))
  expect(decode(bytes("x")), "a lone ESC before a normal key is a cancel").toEqual([
    { type: "cancel" },
    { type: "char", char: "x" }
  ])
})

test("an ESC with nothing after it flushes to a cancel, once", () => {
  // Without this a person presses esc and the picker looks hung until they
  // press something else. The driver flushes when the read goes quiet.
  const decode = keyDecoder()
  expect(decode(bytes(ESC)), "a lone ESC must not be guessed at the moment it arrives").toEqual([])
  expect(decode.flush(), "a held ESC must resolve to a cancel when nothing follows it").toEqual([
    { type: "cancel" }
  ])
  expect(decode.flush(), "flushing twice must not emit a second cancel").toEqual([])
})

test("flushing a decoder with nothing held emits nothing", () => {
  const decode = keyDecoder()
  decode(bytes(`${ESC}[A`))
  expect(decode.flush(), "a complete sequence left a partial one behind").toEqual([])
})

test("filtering is case-insensitive and matches the id as well as the label", () => {
  expect(filter(OPTIONS, "").length, "an empty query must not filter anything out").toBe(4)
  expect(
    filter(OPTIONS, "fire").map(o => o.id),
    "the label was not searched"
  ).toEqual(["fireworks"])
  expect(
    filter(OPTIONS, "DEEP").map(o => o.id),
    "the search is case-sensitive"
  ).toEqual(["deepseek"])
  expect(
    filter(OPTIONS, "goo").map(o => o.id),
    "the id was not searched"
  ).toEqual(["google"])
  expect(filter(OPTIONS, "zzz"), "a query matching nothing must return nothing").toEqual([])
})

test("the cursor wraps at both ends rather than sticking", () => {
  expect(nextCursor(0, -1, 4), "up from the first row must wrap to the last").toBe(3)
  expect(nextCursor(3, 1, 4), "down from the last row must wrap to the first").toBe(0)
  expect(nextCursor(1, 1, 4), "a move inside the list must be a move of one").toBe(2)
})

test("exactly one row carries the pointer, and it is the cursor", () => {
  // Both styles, because the pointer is the one thing a person navigates by and
  // a fallback that draws no marker reads as a hung program.
  for (const [style, pointer] of [
    [PLAIN, ">"],
    [PRETTY, "\u276f"]
  ] as const) {
    const at0 = lines({ cursor: 0, style })
    const at2 = lines({ cursor: 2, style })
    const marks = (ls: string[]): number => ls.filter(l => l.includes(pointer)).length
    expect(marks(at0), `the pointer is drawn on more than one row: ${JSON.stringify(at0)}`).toBe(1)
    expect(marks(at2), `the pointer is drawn on more than one row: ${JSON.stringify(at2)}`).toBe(1)
    const rowOf = (ls: string[], id: string): number => ls.findIndex(l => l.includes(id))
    expect(at0[rowOf(at0, "Fireworks")], "the pointer is not on the cursor row").toContain(pointer)
    expect(at2[rowOf(at2, "DeepSeek")], "the pointer did not follow the cursor").toContain(pointer)
  }
})

test("the frame names the providers, their auth and their status", () => {
  const ls = lines()
  const fire = ls.find(l => l.includes("Fireworks"))
  expect(fire, "the provider is missing from the frame").toBeDefined()
  expect(
    fire,
    "the auth kind is missing, so a person cannot tell what they will be asked for"
  ).toContain("api key")
  expect(fire, "a signed-in provider is not marked as signed in").toContain("signed in")
  const anthropic = ls.find(l => l.includes("Anthropic"))
  expect(anthropic, "a provider with no credential is shown as signed in").not.toContain(
    "signed in"
  )
})

test("the frame carries the keys that drive it", () => {
  const head = lines()[0] as string
  expect(head, "the frame must name what is being asked").toContain("Sign in to a model provider")
  for (const hint of ["move", "filter", "enter", "cancel"]) {
    expect(head, `the frame does not say how to ${hint}`).toContain(hint)
  }
})

test("a long catalog scrolls a window and says how much is off screen", () => {
  const many: Option[] = Array.from({ length: 43 }, (_, i) => ({
    id: `p${i}`,
    label: `Provider ${i}`
  }))
  const top = lines({ options: many, cursor: 0 })
  expect(
    top.filter(l => l.includes("Provider")).length,
    "the whole catalog was drawn"
  ).toBeLessThanOrEqual(WINDOW)
  expect(top.join("\n"), "nothing says the list continues below").toContain("more")

  const bottom = lines({ options: many, cursor: 42 })
  const drawn = bottom.filter(l => l.includes("Provider"))
  expect(drawn.length, "the viewport grew instead of scrolling").toBeLessThanOrEqual(WINDOW)
  expect(
    bottom.find(l => l.includes("Provider 42")),
    "the cursor scrolled off the screen it is drawn in"
  ).toBeDefined()
  expect(bottom.join("\n"), "nothing says the list continues above").toContain("more")
})

test("the frame shows the filter, and says so when it matches nothing", () => {
  const filtered = lines({ query: "fire" })
  expect(
    filtered.join("\n"),
    "the active filter is not shown, so the screen looks broken"
  ).toContain("fire")
  expect(
    filtered.join("\n"),
    "a filtered frame still offers the rows it filtered out"
  ).not.toContain("Anthropic")
  expect(lines({ query: "zzz" }).join("\n"), "an empty result must say so").toContain("no provider")
})

test("a plain frame carries no escape sequences", () => {
  const text = lines().join("\n")
  expect(text, `a piped frame must be plain text:\n${text}`).not.toContain(String.fromCharCode(27))
})

test("a dumb terminal gets an ASCII pointer instead of a glyph", () => {
  const ascii = lines({ style: PLAIN }).join("\n")
  const pretty = lines({ style: PRETTY }).join("\n")
  expect(ascii, "the ASCII fallback still drew the unicode pointer").not.toContain("\u276f")
  expect(ascii, "the ASCII fallback drew no pointer at all").toContain(">")
  expect(pretty, "a colour terminal should get the pointer glyph").toContain("\u276f")
})

test("a piped picker prints a numbered list and takes a number", async () => {
  const written: string[] = []
  const answers = ["2"]
  const id = await pick("Sign in to a model provider", OPTIONS, PLAIN, {
    isTTY: false,
    out: s => written.push(s),
    read: async () => answers.shift() as string
  })
  expect(id, "a number did not select the row it numbers").toBe("anthropic")
  const text = written.join("")
  // '1' alone proves nothing: it is in the title, in a detail, anywhere. What the
  // fallback promises is that the row a number NAMES is the row it NUMBERS, so the
  // number has to stand in front of the label — '2' selecting 'anthropic' above is
  // only meaningful because the list said `2) Anthropic`.
  const rows = text.split("\n")
  expect(
    rows.some(row => /^\s*2\) Anthropic/.test(row)),
    `the fallback list must number its rows: nothing in ${JSON.stringify(rows)} reads "2) Anthropic"`
  ).toBe(true)
  expect(
    rows.some(row => /^\s*1\) Fireworks/.test(row)),
    "the first row must be numbered 1"
  ).toBe(true)
  expect(text, "the fallback list does not name the providers").toContain("Fireworks")
})

test("a piped picker also takes a provider typed by name", async () => {
  const id = await pick("Sign in to a model provider", OPTIONS, PLAIN, {
    isTTY: false,
    out: () => {},
    read: async () => "deepseek"
  })
  expect(id, "a typed provider id was not accepted").toBe("deepseek")
})

test("a piped picker refuses a choice that is not offered", async () => {
  await expect(
    pick("Sign in to a model provider", OPTIONS, PLAIN, {
      isTTY: false,
      out: () => {},
      read: async () => "not-a-provider"
    }),
    "an unknown choice was accepted"
  ).rejects.toThrow("not-a-provider")
})

test("a piped picker can be quit without signing in to anything", async () => {
  const id = await pick("Sign in to a model provider", OPTIONS, PLAIN, {
    isTTY: false,
    out: () => {},
    read: async () => "q"
  })
  expect(id, "quitting must select nothing, not the first row").toBe(null)
})
