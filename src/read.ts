/**
 * Stage 1 read ladder (R4, R5, I2).
 *
 * read() extracts a document's content by the cheapest faithful route:
 * a usable text layer first ("text"), macOS Vision OCR over page images
 * next ("ocr"), and a vision model over those same page images only when
 * OCR comes back weak ("vision"). Text handed onward is capped at 4000
 * characters (R4).
 */
import type { Config } from './config.ts'

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
  const m = /\.[^.\/]+$/.exec(file)
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

// --- macOS Vision OCR helper -------------------------------------------------
// A tiny Swift program using VNRecognizeTextRequest, compiled once into the
// temp directory and reused. Native Bun + platform frameworks only (D2).

const OCR_SWIFT = `import Vision
import Foundation
var out: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([req])
    var texts: [String] = []
    var confs: [Double] = []
    for obs in req.results ?? [] {
        if let c = obs.topCandidates(1).first {
            texts.append(c.string)
            confs.append(Double(c.confidence))
        }
    }
    let mean: Any = confs.isEmpty ? NSNull() : confs.reduce(0, +) / Double(confs.count)
    out.append(["text": texts.joined(separator: "\\n"), "confidence": mean])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
`

let ocrBinaryPromise: Promise<string> | null = null

function ocrBinary(): Promise<string> {
  if (!ocrBinaryPromise) {
    ocrBinaryPromise = (async () => {
      const bin = tmpPath('ocr-v1')
      if (await Bun.file(bin).exists()) return bin
      const src = tmpPath('ocr-v1.swift')
      await Bun.write(src, OCR_SWIFT)
      const proc = Bun.spawnSync(['swiftc', '-O', '-o', bin, src])
      if (proc.exitCode !== 0) {
        const signal = (proc as { signalCode?: string | null }).signalCode
        throw new Error(
          `ocrPages: failed to build the Vision OCR helper (exit ${proc.exitCode}, signal ${signal ?? 'none'}): ` +
            `${proc.stderr.toString().trim()} ${proc.stdout.toString().trim()}`.trim()
        )
      }
      return bin
    })()
  }
  return ocrBinaryPromise
}

/** OCR each page image; returns joined text, its length and the mean confidence. */
export async function ocrPages(
  pages: string[]
): Promise<{ text: string; chars: number; meanConfidence: number | null }> {
  if (pages.length === 0) return { text: '', chars: 0, meanConfidence: null }
  const bin = await ocrBinary()
  const proc = Bun.spawnSync([bin, ...pages])
  if (proc.exitCode !== 0) {
    throw new Error(
      `ocrPages: Vision OCR failed on ${pages.join(', ')}: ${proc.stderr.toString().trim()}`
    )
  }
  const rows = JSON.parse(proc.stdout.toString()) as { text: string; confidence: number | null }[]
  const text = rows
    .map(r => r.text)
    .filter(t => t.length > 0)
    .join('\n')
  const confs = rows.map(r => r.confidence).filter((c): c is number => typeof c === 'number')
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
  for (const m of raw.matchAll(/\[((?:[^\[\]]|\\.)*)\]\s*TJ/g)) {
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

// --- Vision fallback (I2) ------------------------------------------------------

async function readByVision(images: string[], config: Config): Promise<string> {
  const { getModel, completeSimple } = await import('@earendil-works/pi-ai')
  const ref = config.models.vision
  const slash = ref.indexOf('/')
  const model =
    slash >= 0
      ? getModel(ref.slice(0, slash) as never, ref.slice(slash + 1))
      : (getModel('anthropic' as never, ref) ?? getModel('google' as never, ref))
  if (!model)
    throw new Error(`read: vision fallback needs a known model, config.models.vision is "${ref}"`)
  const content: any[] = [
    { type: 'text', text: 'Transcribe this document page verbatim. Reply with the text only.' }
  ]
  for (const img of images) {
    const bytes = new Uint8Array(await Bun.file(img).arrayBuffer())
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    content.push({ type: 'image', data: btoa(bin), mimeType: 'image/png' })
  }
  const msg = await completeSimple(
    model as never,
    { messages: [{ role: 'user', content }] } as never
  )
  const text = (msg as any).content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
  if (!text.trim())
    throw new Error(`read: vision model ${ref} returned no text for ${images.join(', ')}`)
  return text
}

// --- The ladder -----------------------------------------------------------------

export async function read(file: string, config: Config): Promise<Content> {
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
    const ocr = await ocrPages([png])
    if (ocr.meanConfidence !== null && ocr.meanConfidence >= OCR_MIN_CONFIDENCE) {
      return {
        text: ocr.text.slice(0, TEXT_CAP),
        images: [],
        method: 'ocr',
        ocrConfidence: ocr.meanConfidence,
        pages
      }
    }
    const text = await readByVision([png], config)
    return {
      text: text.slice(0, TEXT_CAP),
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
    const text = await readByVision([file], config)
    return {
      text: text.slice(0, TEXT_CAP),
      images: [file],
      method: 'vision',
      ocrConfidence: ocr.meanConfidence,
      pages: 1
    }
  }

  throw new Error(`read: unsupported file type "${ext}" for ${file}`)
}
