/**
 * Stage 1 read ladder (R4, R5, I2).
 *
 * read() extracts a document's content by the cheapest faithful route:
 * a usable text layer first ("text"), macOS Vision OCR over page images
 * next ("ocr"), and — when OCR comes back weak — the page images ride along
 * as "vision" for Stage 2's model call, which is the only stage that looks
 * at them. Text handed onward is capped at 4000 characters (R4).
 */

export type Content = {
  text: string
  images: string[]
  method: 'text' | 'ocr' | 'vision'
  ocrConfidence: number | null
  pages: number
}

/** Text handed to a model is capped at 4000 characters (R4). */
const TEXT_CAP = 4000
/** Mean OCR confidence below which the ladder falls back to vision (I2). */
const OCR_MIN_CONFIDENCE = 0.8

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'])

function extOf(file: string): string {
  const m = /\.[^./]+$/.exec(file)
  return m ? m[0].toLowerCase() : ''
}

function tmpPath(name: string): string {
  return `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-${name}`
}

/** Pull a locally-evicted iCloud file back down before reading it (R5). */
export async function downloadICloud(file: string): Promise<void> {
  const f = Bun.file(file)
  if (await f.exists()) return
  const proc = Bun.spawnSync(['brctl', 'download', file])
  if (!(await f.exists())) {
    throw new Error(
      `downloadICloud: ${file} is not on disk and brctl could not fetch it: ${proc.stderr.toString().trim()}`
    )
  }
}

// --- macOS Vision OCR (mac-ocr) ----------------------------------------------
// mac-ocr wraps VNRecognizeTextRequest in a prebuilt MIT binary shipped as a
// project dependency, so the CLI depends on neither a global install nor a
// first-run swiftc compile. Native Bun + platform frameworks only (D2).

/** Resolve mac-ocr: PATH first, then this project's own install (R5). */
let macOcrPromise: Promise<string> | null = null

function macOcrBinary(): Promise<string> {
  if (!macOcrPromise) {
    macOcrPromise = (async () => {
      const onPath = Bun.which('mac-ocr')
      if (onPath !== null) return onPath
      const local = `${import.meta.dir}/../node_modules/mac-ocr/bin/mac-ocr`
      if (await Bun.file(local).exists()) return local
      throw new Error(
        `ocrPages: mac-ocr is not installed: nothing named mac-ocr on PATH and none at ${local}. Run \`bun add mac-ocr\`.`
      )
    })()
  }
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
  const proc = Bun.spawnSync([bin, ...pages, '--format', 'json'])
  if (proc.exitCode !== 0) {
    throw new Error(
      `ocrPages: Vision OCR failed on ${pages.join(', ')}: ${proc.stderr.toString().trim()}`
    )
  }
  const results = JSON.parse(proc.stdout.toString()) as MacOcrPage[]
  const text = results
    .map(p => p.text)
    .filter(t => t.length > 0)
    .join('\n')
  const confs = results.flatMap(p => p.observations.map(o => o.confidence))
  const meanConfidence = confs.length === 0 ? null : confs.reduce((a, b) => a + b, 0) / confs.length
  return { text, chars: text.length, meanConfidence }
}

// --- Text-layer extraction ---------------------------------------------------

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

/** Rasterize the first page of a PDF to a PNG via sips; returns the PNG path. */
function pdfToPng(file: string): string {
  const out = tmpPath(`page-${crypto.randomUUID()}.png`)
  const proc = Bun.spawnSync(['sips', '-s', 'format', 'png', file, '--out', out])
  if (proc.exitCode !== 0) {
    throw new Error(`read: sips could not rasterize ${file}: ${proc.stderr.toString().trim()}`)
  }
  return out
}

/**
 * Page images for a vision call (I2). macOS ships no CLI that extracts page N>1
 * of a PDF as an image — sips writes page 1 only — so a vision fallback sees the
 * document's first page, which carries its issuer, date and reference.
 */
export function pageImages(file: string): string[] {
  const ext = extOf(file)
  if (IMAGE_EXTS.has(ext)) return [file]
  if (ext === '.pdf') return [pdfToPng(file)]
  return []
}

// --- The ladder -----------------------------------------------------------------

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
    const png = pdfToPng(file)
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
