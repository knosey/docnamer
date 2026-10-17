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

;(globalThis as unknown as { flow: (name: string, fn: unknown) => void }).flow = (
  name: string,
  fn: unknown
): void => {
  // A flow drives the real CLI end to end: Apple Vision OCR plus one paid model
  // call per document, run one file at a time. That is tens of seconds, well past
  // the 5s bun allows a test by default, and `[test] timeout` in bunfig.toml is
  // not applied by bun 1.4.2 — so the budget is named here, in code.
  test(name, fn as () => unknown, 300000)
}
