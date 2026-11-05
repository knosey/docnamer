/**
 * E2E for interaction I5 — photo title stays short
 * (docs/features/naming-rules/INTERACTIONS.md).
 *
 * Outcome: planning a photo that is not a readable document proposes a filename
 * of at most 100 characters whose title is about six words, not a paragraph.
 *
 * The digraph is entry → step → outcome. This file is those harness calls in
 * that order, then the assertion of the Outcome on `s.names`. The harness owns
 * the folder, the seeded photo, and `docnamer plan`.
 */
import { Session, entry, outcome, step } from "./naming-rules-harness.ts"

/** About six words, not a paragraph: a date token plus a short title still fits; a sentence does not. */
const TITLE_WORDS = 8

const words = (title: string): string[] => title.split(/[\s_-]+/).filter(w => w.length > 0)

flow("naming-rules I5: photo title stays short", async () => {
  const s = new Session("I5")
  await entry(s)
  await step(s)
  await outcome(s)

  if (s.names.length !== 1) {
    throw new Error(
      `I5 outcome: expected one proposed name for the photo, got ${s.names.length}: ${s.names.join(", ")}`
    )
  }
  const name = s.names[0].split("/").pop() ?? s.names[0]
  if (name.length > 100) {
    throw new Error(
      `I5 outcome: proposed name is ${name.length} characters, over the 100-character cap: ${name}`
    )
  }
  const title = name.replace(/\.[^.]+$/, "")
  const titleWords = words(title)
  if (titleWords.length > TITLE_WORDS || /[.;:]/.test(title)) {
    throw new Error(
      `I5 outcome: title is a paragraph (${titleWords.length} words), not about six words: ${title}`
    )
  }
})
