// --- R4 formats: direct text extraction for xlsx/pptx/pages ------------------
//
// BRIEF.md R4 requires direct text extraction for xlsx, pptx and pages, beside
// txt/md/docx. A format read() cannot handle returns null — Stage 1's SKIP —
// and the file silently never appears in the plan. This suite pins extraction
// for all three formats against fixtures built here, in a tmp dir, from the
// native `zip` CLI: deterministic, and no binary fixtures committed.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { read } from '../src/read.ts'

const dir = `${Bun.env.TMPDIR ?? '/tmp'}/read-formats-${crypto.randomUUID()}`
const fixtures = {
  xlsx: `${dir}/budget.xlsx`,
  pptx: `${dir}/deck.pptx`,
  pptxBad: `${dir}/deck-bad-crc.pptx`,
  pages: `${dir}/minutes.pages`
}

// The slide both pptx fixtures carry, so the corrupt copy below differs from the
// good one by exactly the one byte that is flipped.
const SLIDE_XML =
  `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly forecast review</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`

// Build each fixture with `zip` run from the staging root so the archive
// paths (xl/sharedStrings.xml, ppt/slides/…) survive into the zip.
const zipTree = (out: string, files: string[]) => {
  const p = Bun.spawnSync(['zip', '-q', out, ...files], { cwd: `${dir}/stage` })
  if (p.exitCode !== 0) throw new Error(`fixture zip failed: ${p.stderr.toString()}`)
  for (const f of files) Bun.spawnSync(['rm', '-f', `${dir}/stage/${f}`])
}

// The same tree, stored uncompressed, so its entry bytes can be corrupted in
// place. The central directory is left alone: `unzip -Z1` keeps listing the
// entry while `unzip -p` refuses it (exit 2, "bad CRC").
const zipTreeStored = (out: string, files: string[]) => {
  const p = Bun.spawnSync(['zip', '-q', '-0', out, ...files], { cwd: `${dir}/stage` })
  if (p.exitCode !== 0) throw new Error(`fixture zip failed: ${p.stderr.toString()}`)
  for (const f of files) Bun.spawnSync(['rm', '-f', `${dir}/stage/${f}`])
}

const stageFile = async (name: string, body: string) => {
  const path = `${dir}/stage/${name}`
  Bun.spawnSync(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
  await Bun.write(path, body)
}

beforeAll(async () => {
  Bun.spawnSync(['mkdir', '-p', `${dir}/stage`])

  // Minimal xlsx: the strings live in xl/sharedStrings.xml inside <t> tags.
  await stageFile(
    'xl/sharedStrings.xml',
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<si><t>Invoice Q3 totals</t></si><si><t>Amount due 1200</t></si></sst>`
  )
  zipTree(fixtures.xlsx, ['xl/sharedStrings.xml'])

  // Minimal pptx: slide text lives in <a:t> tags under ppt/slides/.
  await stageFile('ppt/slides/slide1.xml', SLIDE_XML)
  zipTree(fixtures.pptx, ['ppt/slides/slide1.xml'])

  // The same slide, stored uncompressed and then corrupted by one byte: the
  // archive still lists ppt/slides/slide1.xml and can no longer extract it.
  await stageFile('ppt/slides/slide1.xml', SLIDE_XML)
  zipTreeStored(fixtures.pptxBad, ['ppt/slides/slide1.xml'])
  const bad = new Uint8Array(await Bun.file(fixtures.pptxBad).arrayBuffer())
  // Anchor on the whole word, never on a single byte. 0x51 also occurs in the
  // local file header, whose mod-time bytes come from the staged file's mtime and
  // therefore differ on every run; flipping one of those corrupts nothing unzip
  // checks, so the entry still extracts and this suite fails for a reason that has
  // nothing to do with read(). "Quarterly" occurs once in the archive, inside the
  // stored entry data. latin1 is one byte per char, so the index is a byte offset.
  const at = new TextDecoder('latin1').decode(bad).indexOf('Quarterly')
  if (at < 0) throw new Error('fixture: slide text missing from the stored archive')
  bad[at] = 0x71
  await Bun.write(fixtures.pptxBad, bad)
  // The flip must land in the entry data or the fixture is not corrupt at all;
  // prove it here so a bad offset fails as a fixture fault rather than as a read()
  // bug in the case below.
  const check = Bun.spawnSync(['unzip', '-p', fixtures.pptxBad, 'ppt/slides/slide1.xml'])
  if (check.exitCode === 0)
    throw new Error('fixture: the byte flip missed the entry data — unzip still extracts it')

  // .pages carries no plain-text stream; readers go through the embedded
  // QuickLook preview PDF. The Stage 1 text-layer parser reads literal strings
  // out of the content stream, so a preview carrying them is what a real
  // Pages export ships.
  await stageFile(
    'QuickLook/Preview.pdf',
    `%PDF-1.4\n1 0 obj<</Type/Page>>endobj\nstream\nBT /F1 12 Tf (Board minutes of the annual general meeting) Tj ET\nendstream\n`
  )
  zipTree(fixtures.pages, ['QuickLook/Preview.pdf'])
})

afterAll(() => {
  Bun.spawnSync(['rm', '-rf', dir])
})

test('read() extracts text from xlsx shared strings', async () => {
  const c = await read(fixtures.xlsx)
  if (c === null) throw new Error('read() skipped xlsx: null means Stage 1 silently drops it from the plan')
  expect(c.method).toBe('text')
  expect(c.text).toContain('Invoice Q3 totals')
  expect(c.text).toContain('Amount due 1200')
})

test('read() extracts slide text from pptx', async () => {
  const c = await read(fixtures.pptx)
  if (c === null) throw new Error('read() skipped pptx: null means Stage 1 silently drops it from the plan')
  expect(c.method).toBe('text')
  expect(c.text).toContain('Quarterly forecast review')
})

// A slide the archive lists but cannot extract is not an empty slide: returning
// '' for it dropped a whole deck's text into a silent, unflagged "other".
test('read() throws naming the slide a pptx lists but cannot extract', async () => {
  await expect(read(fixtures.pptxBad)).rejects.toThrow(/ppt\/slides\/slide1\.xml/)
})

test('read() extracts text from a pages document via its QuickLook preview', async () => {
  const c = await read(fixtures.pages)
  if (c === null) throw new Error('read() skipped pages: null means Stage 1 silently drops it from the plan')
  expect(c.method).toBe('text')
  expect(c.text).toContain('Board minutes of the annual general meeting')
})

test('read() throws naming the missing preview for a pages file with none', async () => {
  await stageFile('index.xml', '<empty/>')
  zipTree(`${dir}/broken.pages`, ['index.xml'])
  await expect(read(`${dir}/broken.pages`)).rejects.toThrow(/pages.*QuickLook\/Preview\.pdf|QuickLook\/Preview\.pdf.*pages/i)
})
