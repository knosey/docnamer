// The skip→named-message rule has ONE owner (tests/preload.ts). A `Skipped` must
// never reach the runner as a green, and the failure must name the flow rather
// than only the step inside it. Two specs used to carry their own copy of this
// and five carried none, so the same hole reported differently per flow (F33).
// Pure, so it is pinned here without paying for a model run (R2).

import { test, expect } from "bun:test"
import { flowFailure } from "./preload.ts"

test("flowFailure names the flow whose hole could not be demonstrated", () => {
  const hole = Object.assign(new Error("Stage 2 needs a live model"), { skip: true })
  expect(flowFailure("doc-renamer-pipeline I1", hole).message).toBe(
    "doc-renamer-pipeline I1 not demonstrated: Stage 2 needs a live model"
  )
})

test("flowFailure passes a real failure through unchanged", () => {
  const real = new Error("docnamer plan exited 1")
  expect(flowFailure("doc-renamer-pipeline I1", real)).toBe(real)
})
