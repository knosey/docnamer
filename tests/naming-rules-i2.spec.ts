/**
 * E2E test for I2: invoice versions stay distinct
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * Digraph steps in order: entry -> step -> outcome. The harness owns seeding
 * `20260006 Crowdbuilding February v3.pdf` and `20260006 Crowdbuilding V4.pdf`
 * and running `docnamer plan`. This file asserts the Outcome: two invoice
 * names that print `v3` and `V4`, and neither name is the other plus only ` (2)`.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

const base = (name: string): string => name.split("/").pop() ?? name

/** `token` printed as its own field, not buried inside a longer word. */
const prints = (name: string, token: string): boolean => {
  const b = base(name)
  let from = 0
  while (from <= b.length - token.length) {
    const i = b.indexOf(token, from)
    if (i < 0) return false
    const before = i === 0 ? " " : b[i - 1]
    const after = b[i + token.length] ?? " "
    const edge = (c: string): boolean =>
      c < "0" || (c > "9" && c < "A") || (c > "Z" && c < "a") || c > "z"
    if (edge(before) && edge(after)) return true
    from = i + 1
  }
  return false
}

/** `b` is `a` with only a Finder ` (2)` collision suffix added before the extension. */
const onlyCollision = (a: string, b: string): boolean => {
  const file = base(a)
  const dot = file.lastIndexOf(".")
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ""
  return base(b) === `${stem} (2)${ext}`
}

flow("naming-rules I2: invoice versions stay distinct", async () => {
  const s = new Session("I2")
  await entry(s)
  await step(s)
  await outcome(s)

  if (s.names.length !== 2) {
    throw new Error(`I2: expected two proposed names, got ${s.names.length}: ${s.names.join(", ")}`)
  }
  const [a, b] = s.names
  if (
    !prints(a, "invoice") &&
    !prints(b, "invoice") &&
    !prints(a, "Invoice") &&
    !prints(b, "Invoice")
  ) {
    throw new Error(`I2: neither name is an invoice name: ${s.names.join(", ")}`)
  }
  const v3 = s.names.filter(n => prints(n, "v3"))
  const v4 = s.names.filter(n => prints(n, "V4"))
  if (v3.length !== 1 || v4.length !== 1) {
    throw new Error(
      `I2: expected one name printing v3 and one printing V4, got ${s.names.join(", ")}`
    )
  }
  if (onlyCollision(a, b) || onlyCollision(b, a)) {
    throw new Error(`I2: one name is the other plus only " (2)": ${s.names.join(", ")}`)
  }
})
