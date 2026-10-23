/**
 * Stage 1 read ladder.
 *
 * read() extracts a document's content by the cheapest faithful route: a usable
 * text layer first ("text"), macOS Vision OCR over page images next ("ocr"), and
 * — when OCR comes back weak — the page images ride along as "vision" for Stage
 * 2's model call, the only stage that looks at them. Text handed onward is capped
 * at 4000 characters.
 */

export type Content = {
  text: string
  images: string[]
  method: 'text' | 'ocr' | 'vision'
  ocrConfidence: number | null
  pages: number
}

const TEXT_CAP = 4000
/** Mean OCR confidence below which the ladder falls back to vision. */
const OCR_MIN_CONFIDENCE = 0.8

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'])

function extOf(file: string): string {
  const m = /\.[^./]+$/.exec(file)
  return m ? m[0].toLowerCase() : ''
}

function tmpPath(name: string): string {
  // `Bun.env.TMPDIR` is the sanctioned spelling here: src/ may not import a
  // node: built-in, so the platform temp dir is read from the environment with
  // /tmp as the only fallback.
  return `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-${name}`
}

/** Pull a locally-evicted iCloud file back down before reading it. */
async function downloadICloud(file: string): Promise<void> {
  const f = Bun.file(file)
  if (await f.exists()) return
  const proc = Bun.spawnSync(['brctl', 'download', file])
  if (!(await f.exists())) {
    throw new Error(
      `downloadICloud: ${file} is not on disk and brctl could not fetch it: ${proc.stderr.toString().trim()}`
    )
  }
}

// --- macOS Vision OCR (mac-ocr) --------------------------------------------
// mac-ocr wraps VNRecognizeTextRequest in a prebuilt MIT binary shipped as a
// project dependency, so the CLI depends on neither a global install nor a
// first-run swiftc compile.

/** Resolve mac-ocr from this project's own install only, never PATH. */
import macOcr from '../node_modules/mac-ocr/bin/mac-ocr' with { type: 'file' }
import macOcrPkg from '../node_modules/mac-ocr/package.json'

/** sha256 of the embedded mac-ocr binary, pinned so the copy shipped in node_modules is the only mac-ocr ever exec'd. */
const MAC_OCR_SHA256 = '1817fff474a88706104167f8f47983ecea93a3b41cd10fa6b8585c026ffd7668'

let macOcrPromise: Promise<string> | null = null

const sha256 = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

/**
 * Unpack the mac-ocr copy embedded in the compiled binary. A compiled binary's
 * own asset path is Bun's virtual `/$bunfs/...`, which cannot be exec'd, so the
 * bytes are written to TMPDIR and chmod'd 755 — `Bun.write`'s mode option is
 * silently ignored inside a compiled binary, so the chmod is not optional.
 * A copy already at the destination is reused only when it hashes to the pin.
 */
async function unpackMacOcr(): Promise<string> {
  const tmp = Bun.env.TMPDIR
  if (tmp === undefined) {
    throw new Error('ocrPages: TMPDIR is unset, so the embedded mac-ocr has nowhere to unpack to')
  }
  const dest = `${tmp}/docnamer-mac-ocr-${macOcrPkg.version}`
  if ((await Bun.file(dest).exists()) && (await sha256(dest)) === MAC_OCR_SHA256) return dest
  const bytes = Bun.file(macOcr)
  const hash = new Bun.CryptoHasher('sha256')
  hash.update(await bytes.arrayBuffer())
  if (hash.digest('hex') !== MAC_OCR_SHA256) {
    throw new Error(`ocrPages: the embedded mac-ocr fails its sha256 pin (${MAC_OCR_SHA256})`)
  }
  await Bun.write(dest, bytes)
  Bun.spawnSync(['chmod', '755', dest])
  return dest
}

function macOcrBinary(): Promise<string> {
  if (!macOcrPromise) macOcrPromise = unpackMacOcr()
  return macOcrPromise
}

/** One page of `mac-ocr --format json` output. */
type MacOcrPage = {
  page: number
  pageCount: number
  text: string
  observations: { confidence: number; text: string }[]
}

/** OCR each page image; returns joined text, its length and the mean confidence. */
export async function ocrPages(
  pages: string[]
): Promise<{ text: string; chars: number; meanConfidence: number | null }> {
  if (pages.length === 0) return { text: '', chars: 0, meanConfidence: null }
  const bin = await macOcrBinary()
  const { out, err, code } = await spawnPiped([bin, ...pages, '--format', 'json'], 'ocrPages')
  if (code !== 0) {
    throw new Error(`ocrPages: Vision OCR failed on ${pages.join(', ')}: ${err.trim()}`)
  }
  const results = JSON.parse(out) as MacOcrPage[]
  const text = results
    .map(p => p.text)
    .filter(t => t.length > 0)
    .join('\n')
  const confs = results.flatMap(p => p.observations.map(o => o.confidence))
  const meanConfidence = confs.length === 0 ? null : confs.reduce((a, b) => a + b, 0) / confs.length
  return { text, chars: text.length, meanConfidence }
}

// --- Text-layer extraction -------------------------------------------------

function unescapePdfString(s: string): string {
  return s.replace(/\\([\\()nrtbf]|[0-7]{1,3})/g, (_m, g: string) => {
    switch (g) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case '\\':
        return '\\'
      case '(':
        return '('
      case ')':
        return ')'
      default:
        return String.fromCharCode(parseInt(g, 8))
    }
  })
}

/** Pull the literal strings out of uncompressed PDF content streams. */
function pdfTextLayer(raw: string): string {
  const chunks: string[] = []
  // ( ... ) Tj
  for (const m of raw.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) chunks.push(m[1])
  // [ ( ... ) -12 ( ... ) ] TJ
  for (const m of raw.matchAll(/\[((?:[^[\]]|\\.)*)\]\s*TJ/g)) {
    for (const s of m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) chunks.push(s[1])
  }
  return chunks.map(unescapePdfString).join(' ').replace(/\s+/g, ' ').trim()
}

function pdfPageCount(raw: string): number {
  let n = 0
  for (const _ of raw.matchAll(/\/Type\s*\/Page(?![s\w])/g)) n++
  return Math.max(n, 1)
}

/**
 * Run a child without blocking the thread. `spawnSync` freezes the plan
 * spinner: its 80ms interval cannot paint until the child exits.
 */
async function spawnPiped(
  cmd: string[],
  label: string
): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = proc.stdout
  const stderr = proc.stderr
  if (stdout === undefined || stderr === undefined) {
    throw new Error(`${label}: ${cmd[0]} gave no stdout or stderr pipe`)
  }
  const [out, err, code] = await Promise.all([
    new Response(stdout).text(),
    new Response(stderr).text(),
    proc.exited
  ])
  return { out, err, code }
}

/** Rasterize the first page of a PDF to a PNG via sips; returns the PNG path. */
async function pdfToPng(file: string): Promise<string> {
  const out = tmpPath(`page-${crypto.randomUUID()}.png`)
  const { code, err } = await spawnPiped(
    ['sips', '-s', 'format', 'png', file, '--out', out],
    'read'
  )
  if (code !== 0) {
    throw new Error(`read: sips could not rasterize ${file}: ${err.trim()}`)
  }
  return out
}

/**
 * Page images for a vision call. macOS ships no CLI that extracts page N>1 of a
 * PDF as an image — sips writes page 1 only — so a vision fallback sees the
 * document's first page, which carries its issuer, date and reference.
 */
export async function pageImages(file: string): Promise<string[]> {
  const ext = extOf(file)
  if (IMAGE_EXTS.has(ext)) return [file]
  if (ext === '.pdf') return [await pdfToPng(file)]
  return []
}

// --- OOXML / iWork extraction ---------------------------------------------
// xlsx and pptx are zip archives of XML; a .pages document is a zip whose only
// readable text is the embedded QuickLook preview PDF. `unzip` ships with macOS,
// like sips and textutil, so extraction stays native.

/** One entry of a zip archive as text; null when the archive lacks the entry. */
function zipEntry(file: string, entry: string): string | null {
  const proc = Bun.spawnSync(['unzip', '-p', file, entry])
  if (proc.exitCode !== 0) return null
  return proc.stdout.toString()
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Text content of every `<tag>` element in an XML document, in document order. */
function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(re)].map(m => unescapeXml(m[1]))
}

/** Direct text extraction for xlsx, pptx and pages. */
async function officeText(file: string, ext: string): Promise<string> {
  if (ext === '.xlsx') {
    const shared = zipEntry(file, 'xl/sharedStrings.xml')
    if (shared === null) {
      throw new Error(`read: ${file} is an xlsx with no xl/sharedStrings.xml`)
    }
    return xmlTexts(shared, 't').join(' ')
  }
  if (ext === '.pptx') {
    const listing = Bun.spawnSync(['unzip', '-Z1', file])
    if (listing.exitCode !== 0) {
      throw new Error(`read: unzip could not list ${file}: ${listing.stderr.toString().trim()}`)
    }
    const slides = listing.stdout
      .toString()
      .split('\n')
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort()
    const texts: string[] = []
    for (const s of slides) {
      const xml = zipEntry(file, s)
      if (xml === null) {
        throw new Error(`read: ${file} lists ${s} but unzip cannot extract it`)
      }
      texts.push(...xmlTexts(xml, 'a:t'))
    }
    return texts.join(' ')
  }
  // .pages: the document body is protobuf; the readable text is the QuickLook
  // preview PDF every Pages export embeds, parsed by the PDF text-layer path.
  const proc = Bun.spawnSync(['unzip', '-p', file, 'QuickLook/Preview.pdf'])
  if (proc.exitCode !== 0) {
    throw new Error(
      `read: ${file} is a pages document with no QuickLook/Preview.pdf, so there is no text to extract`
    )
  }
  const raw = new TextDecoder('latin1').decode(proc.stdout)
  return pdfTextLayer(raw)
}

// --- The ladder ------------------------------------------------------------

/**
 * Reads one document. `null` is Stage 1's SKIP: a type the ladder cannot read is
 * not an error, and spec Stage 1 returns SKIP("unsupported type") for it.
 */
export async function read(file: string): Promise<Content | null> {
  await downloadICloud(file)
  const ext = extOf(file)

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    const text = (await Bun.file(file).text()).slice(0, TEXT_CAP)
    return { text, images: [], method: 'text', ocrConfidence: null, pages: 1 }
  }

  if (ext === '.docx' || ext === '.doc' || ext === '.rtf') {
    const proc = Bun.spawnSync(['textutil', '-convert', 'txt', '-stdout', file])
    if (proc.exitCode !== 0) {
      throw new Error(
        `read: textutil could not extract text from ${file}: ${proc.stderr.toString().trim()}`
      )
    }
    return {
      text: proc.stdout.toString().slice(0, TEXT_CAP),
      images: [],
      method: 'text',
      ocrConfidence: null,
      pages: 1
    }
  }

  if (ext === '.pdf') {
    const raw = new TextDecoder('latin1').decode(await Bun.file(file).arrayBuffer())
    const layer = pdfTextLayer(raw)
    const pages = pdfPageCount(raw)
    if (layer.length >= 20) {
      return {
        text: layer.slice(0, TEXT_CAP),
        images: [],
        method: 'text',
        ocrConfidence: null,
        pages
      }
    }
    const png = await pdfToPng(file)
    // mac-ocr reads every page of a PDF itself (--pdf-dpi, --password), so the
    // whole document is OCRed, not the first page alone.
    const ocr = await ocrPages([file])
    if (ocr.meanConfidence !== null && ocr.meanConfidence >= OCR_MIN_CONFIDENCE) {
      return {
        text: ocr.text.slice(0, TEXT_CAP),
        images: [],
        method: 'ocr',
        ocrConfidence: ocr.meanConfidence,
        pages
      }
    }
    // OCR was weak: the first page's image rides along for Stage 2's vision call.
    return {
      text: ocr.text.slice(0, TEXT_CAP),
      images: [png],
      method: 'vision',
      ocrConfidence: ocr.meanConfidence,
      pages
    }
  }

  if (ext === '.xlsx' || ext === '.pptx' || ext === '.pages') {
    const text = await officeText(file, ext)
    return {
      text: text.slice(0, TEXT_CAP),
      images: [],
      method: 'text',
      ocrConfidence: null,
      pages: 1
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    const ocr = await ocrPages([file])
    if (ocr.meanConfidence !== null && ocr.meanConfidence >= OCR_MIN_CONFIDENCE) {
      return {
        text: ocr.text.slice(0, TEXT_CAP),
        images: [],
        method: 'ocr',
        ocrConfidence: ocr.meanConfidence,
        pages: 1
      }
    }
    // OCR was weak: the page image rides along for Stage 2's vision call.
    return {
      text: ocr.text.slice(0, TEXT_CAP),
      images: [file],
      method: 'vision',
      ocrConfidence: ocr.meanConfidence,
      pages: 1
    }
  }

  return null
}
