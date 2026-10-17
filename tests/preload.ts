// `flow` is installed on globalThis before spec files load, so an E2E spec
// names its flows the way the layer's runner does (`flow(name, fn)`) while the
// process under `bun run test:e2e` is bun's own test runner, not a hand-rolled
// one. `bun test <file>` runs exactly the file it is given; a flow whose `fn`
// throws fails the run and the runner exits non-zero.
import { test } from "bun:test";

(globalThis as unknown as { flow: (name: string, fn: unknown) => void }).flow = (
  name: string,
  fn: unknown
): void => {
  test(name, fn as () => unknown);
};
