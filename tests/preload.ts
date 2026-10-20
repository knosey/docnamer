// `flow` is installed on globalThis before spec files load, so an E2E spec
// names its flows the way the layer's runner does (`flow(name, fn)`) while the
// process under `bun run test:e2e` is bun's own test runner, not a hand-rolled
// one. `bun test <file>` runs exactly the file it is given; a flow whose `fn`
// throws fails the run and the runner exits non-zero.
import { test } from 'bun:test'

/**
 * A real model call needs FIREWORKS_API_KEY. It is taken from the environment;
 * when the environment does not carry one it is read from pi's own credential
 * file, where it already lives on this machine. This is a test-run convenience
 * only — `src/analyse.ts` reads the environment and nothing else.
 */
export async function ensureProviderKey(): Promise<void> {
  if ((Bun.env.FIREWORKS_API_KEY ?? '').trim().length > 0) return
  const authFile = `${Bun.env.HOME ?? ''}/.pi/agent/auth.json`
  let key: string | undefined
  try {
    const parsed = (await Bun.file(authFile).json()) as { fireworks?: { key?: string } }
    key = parsed.fireworks?.key
  } catch (e) {
    throw new Error(
      `no FIREWORKS_API_KEY in the environment and ${authFile} could not be read: ` +
        (e as Error).message
    )
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error(`no FIREWORKS_API_KEY in the environment and none in ${authFile}`)
  }
  Bun.env.FIREWORKS_API_KEY = key
}

/**
 * The budget a test that waits on a real model call is given. One paid call per
 * document measured 1.5-2.8s with a tail past 5s (2 of 20 fresh-process runs of
 * tests/review.test.ts), while bun allows a test 5s by default — so the default
 * budget sits below the call the test waits on. `[test] timeout` in bunfig.toml
 * is not applied by bun 1.4.2, so the budget is named here, in code, once.
 */
export const MODEL_CALL_MS = 300000

;(globalThis as unknown as { flow: (name: string, fn: unknown) => void }).flow = (
  name: string,
  fn: unknown
): void => {
  // A flow drives the real CLI end to end: Apple Vision OCR plus one paid model
  // call per document, run one file at a time. That is tens of seconds.
  test(name, fn as () => void | Promise<unknown>, MODEL_CALL_MS)
}
