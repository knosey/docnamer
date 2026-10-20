// The reference the graph runner swaps through GRAPH_REFERENCE; assert against it, never edit it.
export const reference =
  process.env.GRAPH_REFERENCE ?? String.raw`./node_modules/.bin/mac-ocr --version`

// src/read.ts and tests/fixtures/ are both absent before the build, so every check below reaches them
// through its own asserted failure — a dynamic import error, an empty listing — never a throw at load.

import { test, expect } from 'bun:test'
import { runChild } from './child.ts'

const repo = import.meta.dir.replace(/\/tests$/, '')
const fixturesDir = `${repo}/tests/fixtures`

/** Import a src module without letting a missing module crash the suite at load. */
async function importSrc(rel: string): Promise<any> {
  try {
    return await import(`${repo}/src/${rel}`)
  } catch (err) {
    return { __error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Every file under tests/fixtures/, relative paths; [] when the directory is absent.
 *
 * The guard cannot be `Bun.file(dir).exists()`: in Bun 1.4.3 that is FALSE for a
 * directory, so it reported an absent directory for a present one and emptied this
 * list. The scan is its own check — it throws ENOENT exactly when the directory is
 * missing, and nothing else when it is there.
 */
async function fixtureFiles(): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: fixturesDir, onlyFiles: true })) {
      out.push(rel)
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
  return out.sort()
}

function withExt(files: string[], ext: string): string[] {
  return files.filter(f => f.toLowerCase().endsWith(ext))
}

// Stage 1's OCR engine is mac-ocr (src/read.ts): the tool that does the recognising is the truth this
// suite is anchored to, and the OCR test below cannot pass without it.
test('reference is the truth this suite is anchored to', async () => {
  const [cmd, ...args] = reference.trim().split(/\s+/)
  let run: { code: number; stdout: string }
  try {
    run = await runChild([cmd as string, ...args], { timeoutMs: 30000 })
  } catch (err) {
    throw new Error(`reference command did not run: ${String(err)}`)
  }
  expect(run.code).toBe(0)
  expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
})

// --- The read ladder (R4, R5) and vision fallback (I2) ------------------------

test('read() plans a text-layer document from its text, sending no image', async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const txt = withExt(files, '.txt')[0]
  expect(txt).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${txt}`)
  expect(content.method).toBe('text')
  expect(content.images).toEqual([])
  expect(content.text.trim().length).toBeGreaterThan(0)
  expect(content.pages).toBeGreaterThanOrEqual(1)
  expect(content.ocrConfidence).toBeNull()
})

test('read() reads a scanned document by OCR, never as a text layer', async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const scanned = files.find(f => /scan/i.test(f) && f.toLowerCase().endsWith('.pdf'))
  expect(scanned).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${scanned}`)
  expect(content.method === 'ocr' || content.method === 'vision').toBe(true)
  expect(content.ocrConfidence).not.toBeNull()
  expect(content.pages).toBeGreaterThanOrEqual(1)
})

test('read() falls back to vision only when OCR is weak (I2)', async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const scanned = files.find(f => /scan/i.test(f) && f.toLowerCase().endsWith('.pdf'))
  expect(scanned).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${scanned}`)
  if (content.method === 'vision') {
    // Vision was chosen because OCR came back weak: page images were sent.
    expect(content.images.length).toBeGreaterThan(0)
    expect(content.ocrConfidence).not.toBeNull()
    expect(content.ocrConfidence).toBeLessThan(0.8)
  } else {
    // OCR was strong enough: no image reached the model.
    expect(content.method).toBe('ocr')
    expect(content.images).toEqual([])
    expect(content.ocrConfidence).toBeGreaterThanOrEqual(0.8)
  }
})

test('ocrPages() reports text, its length and a mean confidence', async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const png = withExt(files, '.png')[0]
  expect(png).toBeDefined()

  const res = await mod.ocrPages([`${fixturesDir}/${png}`])
  // Real text with characters counted — not the implementation's own derivation
  // restated back at it.
  expect(res.text.trim().length).toBeGreaterThan(0)
  expect(res.chars).toBeGreaterThan(0)
  // A mean the ladder can compare against 0.8. `NaN` is a number and `NaN <= 0.8`
  // is false, so the old shape passed on a confidence that would have made
  // read()'s vision fallback unreachable.
  expect(typeof res.meanConfidence).toBe('number')
  expect(res.meanConfidence).toBeGreaterThan(0)
  expect(res.meanConfidence).toBeLessThanOrEqual(1)
})
