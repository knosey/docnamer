// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? 'bun --version'

import { expect, test } from 'bun:test'
import { scratch } from './scratch.ts'

/**
 * S1 — the device IO module.
 *
 * `src/device.ts` is the one place the app touches a terminal it did not
 * inherit: a LaunchServices launch has no controlling tty, so the wrapper hands
 * it a device path, a size and a file to write its exit code into, and the app
 * reads and writes that path with `Bun.file(path).stream()` and
 * `Bun.file(path).writer()`. This file pins that contract before the module
 * exists: the flag parser, the writer and the reader. The real terminal flow
 * belongs to the wrapper's own step, so here a
 * plain temp file stands in for the device — it proves bytes land on the path
 * and come back off it, which is the whole of the abstraction.
 */

type DeviceArgs = {
  tty: string | null
  cols: number | null
  rows: number | null
  exitFile: string | null
  cwd: string | null
}

type DeviceModule = {
  parseDeviceArgs: (argv: string[]) => DeviceArgs
  deviceWriter: (path: string) => { write: (chunk: string) => unknown; end: () => unknown }
  deviceReader: (path: string) => ReadableStream<Uint8Array>
}

/** Import the module under test. A module that will not load is a different
 *  failure from one that is absent, so the cause is rethrown rather than
 *  swallowed: returning null here reported a syntax error as "src/device.ts
 *  must exist", which names the wrong thing to go and fix. */
async function loadDevice(): Promise<DeviceModule> {
  try {
    return (await import('../src/device.ts')) as unknown as DeviceModule
  } catch (e) {
    throw new Error(`src/device.ts could not be imported: ${(e as Error).message}`)
  }
}

/** What the reference command prints — the truth this test compares against. */
function referenceOutput(): string {
  const proc = Bun.spawnSync(['sh', '-c', reference])
  return proc.stdout.toString().trim()
}

test('parseDeviceArgs reads --tty, --cols, --rows, --exit-file and --cwd from argv', async () => {
  const mod = await loadDevice()

  const parsed = mod.parseDeviceArgs([
    'plan',
    '~/docs',
    '--tty',
    '/dev/ttys003',
    '--cols',
    '100',
    '--rows',
    '40',
    '--exit-file',
    '/tmp/docnamer-exit',
    '--cwd',
    '/Users/someone/Downloads'
  ])
  expect(parsed.tty).toBe('/dev/ttys003')
  expect(parsed.cols, '--cols is a number the layout can use').toBe(100)
  expect(parsed.rows, '--rows is a number the layout can use').toBe(40)
  expect(parsed.exitFile).toBe('/tmp/docnamer-exit')
  // LaunchServices starts the app in "/", so the caller's folder can only arrive
  // as a flag; nothing else in the suite pins it to the parser.
  expect(parsed.cwd, '--cwd carries the caller folder across the launch').toBe(
    '/Users/someone/Downloads'
  )

  const none = mod.parseDeviceArgs(['plan', '~/docs'])
  expect(none.tty, 'no --tty means no device mode').toBeFalsy()
  expect(none.cols).toBeFalsy()
  expect(none.rows).toBeFalsy()
  expect(none.exitFile).toBeFalsy()
  expect(none.cwd, 'no --cwd leaves the process in its own directory').toBeFalsy()
})

test('deviceWriter and deviceReader move bytes over the device path', async () => {
  const mod = await loadDevice()

  const truth = referenceOutput()
  expect(truth.length, 'the reference must print a value').toBeGreaterThan(0)

  const path = `${scratch('docnamer-device')}/device`
  const payload = `docnamer-device:${truth}\n`

  const writer = mod.deviceWriter(path)
  await writer.write(payload)
  await writer.end()

  // The bytes must be on the path itself, not only held in memory.
  expect(await Bun.file(path).text(), 'deviceWriter must write to the device path').toBe(payload)
  expect(
    await new Response(mod.deviceReader(path)).text(),
    'deviceReader must read back what deviceWriter wrote'
  ).toBe(payload)
})
