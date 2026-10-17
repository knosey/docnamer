// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`shortcuts list`

// --- T2: Stage 1 read ladder and fixtures ------------------------------------
//
// Covers R4, R5, I2. The program under test is src/read.ts; the fixtures are
// tests/fixtures/. Both are absent before the build, so every check below reaches
// them through its OWN failure — a dynamic import whose error is asserted on, a
// file listing whose emptiness is asserted on — never an uncaught throw at load.

import { test, expect } from "bun:test"

const repo = import.meta.dir.replace(/\/tests$/, "")
const fixturesDir = `${repo}/tests/fixtures`

/** Import a src module without letting a missing module crash the suite at load. */
async function importSrc(rel: string): Promise<any> {
  try {
    return await import(`${repo}/src/${rel}`)
  } catch (err) {
    return { __error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/** Every file under tests/fixtures/, relative paths; [] when the directory is absent. */
async function fixtureFiles(): Promise<string[]> {
  if (!(await Bun.file(fixturesDir).exists())) return []
  const out: string[] = []
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: fixturesDir, onlyFiles: true })) {
    out.push(rel)
  }
  return out.sort()
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] ?? p
}

function withExt(files: string[], ext: string): string[] {
  return files.filter(f => f.toLowerCase().endsWith(ext))
}

// --- The reference -----------------------------------------------------------

test("reference is the truth this suite is anchored to", async () => {
  const [cmd, ...args] = reference.trim().split(/\s+/)
  let code = -1
  let stdout = ''
  try {
    const p = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })
    stdout = await new Response(p.stdout).text()
    code = await p.exited
  } catch (err) {
    throw new Error(`reference command did not run: ${String(err)}`)
  }
  expect(code).toBe(0)
  expect(stdout.trim().length).toBeGreaterThan(0)
})

// --- The module under test ---------------------------------------------------

test("src/read.ts exports the Stage 1 read ladder", async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')
  expect(typeof mod.read).toBe('function')
  expect(typeof mod.downloadICloud).toBe('function')
  expect(typeof mod.ocrPages).toBe('function')
})

// --- Fixtures ----------------------------------------------------------------

test("tests/fixtures holds the Stage 1 fixture set", async () => {
  const files = await fixtureFiles()
  expect(files.length).toBeGreaterThan(0)

  // A text-layer PDF and a scanned PDF: two distinct PDFs, the scanned one named
  // so its expected type is unambiguous.
  expect(withExt(files, '.pdf').length).toBeGreaterThanOrEqual(2)
  expect(files.some(f => /scan/i.test(f))).toBe(true)
  expect(files.some(f => /\.pdf$/i.test(f) && !/scan/i.test(f))).toBe(true)

  expect(withExt(files, '.png').length).toBeGreaterThanOrEqual(1)
  expect(withExt(files, '.docx').length).toBeGreaterThanOrEqual(1)
  expect(withExt(files, '.txt').length).toBeGreaterThanOrEqual(1)
})

test("tests/fixtures holds the byte-identical dup-invoice pair", async () => {
  const files = await fixtureFiles()
  const dups = files.filter(f => /dup-invoice/i.test(basename(f)))
  expect(dups.length).toBeGreaterThanOrEqual(2)

  const bodies = await Promise.all(dups.map(f => Bun.file(`${fixturesDir}/${f}`).text()))
  expect(new Set(bodies).size).toBe(1)
})

// --- The read ladder (R4, R5) and vision fallback (I2) ------------------------

/** A Config for the ladder. Tries the real loader; falls back so the ladder is
 *  still exercised when loadConfig rejects the probe file. */
async function ladderConfig(): Promise<any> {
  const cfgMod = await importSrc('config.ts')
  if (!cfgMod.__error && typeof cfgMod.loadConfig === 'function') {
    const path = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-read-test-${crypto.randomUUID()}.json`
    await Bun.write(
      path,
      JSON.stringify({
        ocrMinConfidence: 0.8,
        ocrConfidenceThreshold: 0.8,
        visionMinConfidence: 0.8
      })
    )
    try {
      return await cfgMod.loadConfig(path)
    } catch {
      /* fall through to the literal below */
    }
  }
  return { ocrMinConfidence: 0.8, ocrConfidenceThreshold: 0.8, visionMinConfidence: 0.8 }
}

test("read() plans a text-layer document from its text, sending no image", async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const txt = withExt(files, '.txt')[0]
  expect(txt).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${txt}`, await ladderConfig())
  expect(content.method).toBe('text')
  expect(content.images).toEqual([])
  expect(content.text.trim().length).toBeGreaterThan(0)
  expect(content.pages).toBeGreaterThanOrEqual(1)
  expect(content.ocrConfidence).toBeNull()
})

test("read() reads a scanned document by OCR, never as a text layer", async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const scanned = files.find(f => /scan/i.test(f) && f.toLowerCase().endsWith('.pdf'))
  expect(scanned).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${scanned}`, await ladderConfig())
  expect(content.method === 'ocr' || content.method === 'vision').toBe(true)
  expect(content.ocrConfidence).not.toBeNull()
  expect(content.pages).toBeGreaterThanOrEqual(1)
})

test("read() falls back to vision only when OCR is weak (I2)", async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const scanned = files.find(f => /scan/i.test(f) && f.toLowerCase().endsWith('.pdf'))
  expect(scanned).toBeDefined()

  const content = await mod.read(`${fixturesDir}/${scanned}`, await ladderConfig())
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

test("ocrPages() reports text, its length and a mean confidence", async () => {
  const mod = await importSrc('read.ts')
  expect(mod.__error?.message ?? '').toBe('')

  const files = await fixtureFiles()
  const png = withExt(files, '.png')[0]
  expect(png).toBeDefined()

  const res = await mod.ocrPages([`${fixturesDir}/${png}`])
  expect(typeof res.text).toBe('string')
  expect(res.chars).toBe(res.text.length)
  expect(res.meanConfidence === null || typeof res.meanConfidence === 'number').toBe(true)
})
