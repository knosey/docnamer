/**
 * T1 Spotlight extras (R5, R6): Finder tags, Finder comments and the OCR
 * text layer that lets Spotlight find a renamed scan by its content.
 *
 * Finder tags are the binary plist in the com.apple.metadata:_kMDItemUserTags
 * xattr; the plist bytes are built and read through plutil, which ships with
 * macOS like xattr and osascript, so the CLI stays native (D2). The OCR text
 * layer is a sidecar `<file>.ocr.txt` written next to the document, carrying
 * the same Vision OCR text Stage 1's read ladder produces.
 */

import { ocrPages } from './read.ts'

const TAG_XATTR = 'com.apple.metadata:_kMDItemUserTags'

function tmpPath(name: string): string {
  return `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-${name}`
}

// --- Tag plist codec -----------------------------------------------------------

/** Encode Finder tags as the binary plist the _kMDItemUserTags xattr stores. */
export function encodeTagPlist(tags: string[]): Uint8Array {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><array>${tags
      .map(t => `<string>${escapeXml(t)}</string>`)
      .join('')}</array></plist>\n`
  const tmp = tmpPath(`tags-${crypto.randomUUID()}.plist`)
  const proc = Bun.spawnSync(['plutil', '-convert', 'binary1', '-o', tmp, '-'], {
    stdin: new TextEncoder().encode(xml)
  })
  if (proc.exitCode !== 0) {
    throw new Error(`encodeTagPlist: plutil could not encode tags: ${proc.stderr.toString().trim()}`)
  }
  return new Uint8Array(Bun.spawnSync(['cat', tmp]).stdout)
}

/** Decode the binary plist stored in the _kMDItemUserTags xattr back to tags. */
export function decodeTagPlist(bytes: Uint8Array): string[] {
  const proc = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', '-'], { stdin: bytes })
  if (proc.exitCode !== 0) {
    throw new Error(`decodeTagPlist: plutil could not decode plist: ${proc.stderr.toString().trim()}`)
  }
  const parsed = JSON.parse(proc.stdout.toString()) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`decodeTagPlist: expected a plist array, got ${typeof parsed}`)
  }
  return parsed.map(t => String(t))
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// --- Finder tags ----------------------------------------------------------------

/** Every Finder tag on the file; [] when the xattr is absent. */
export async function readFinderTags(file: string): Promise<string[]> {
  const proc = Bun.spawnSync(['xattr', '-px', TAG_XATTR, file])
  if (proc.exitCode !== 0) return []
  const hex = proc.stdout.toString().replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return decodeTagPlist(bytes)
}

/** Add a Finder tag to the file, keeping the tags already there. */
export async function setFinderTag(file: string, tag: string): Promise<void> {
  const tags = await readFinderTags(file)
  if (!tags.includes(tag)) tags.push(tag)
  const hex = [...encodeTagPlist(tags)].map(b => b.toString(16).padStart(2, '0')).join(' ')
  const proc = Bun.spawnSync(['xattr', '-wx', TAG_XATTR, hex, file])
  if (proc.exitCode !== 0) {
    throw new Error(`setFinderTag: xattr could not tag ${file}: ${proc.stderr.toString().trim()}`)
  }
}

// --- Finder comment ---------------------------------------------------------------

/** Set the file's Finder comment via Finder itself, so it lands in the .DS_Store store. */
export async function setFinderComment(file: string, comment: string): Promise<void> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Finder" to set comment of (POSIX file "${esc(file)}" as alias) to "${esc(comment)}"`
  const proc = Bun.spawnSync(['osascript', '-e', script])
  if (proc.exitCode !== 0) {
    throw new Error(
      `setFinderComment: osascript could not comment ${file}: ${proc.stderr.toString().trim()}`
    )
  }
}

// --- OCR text layer -----------------------------------------------------------------

/**
 * OCR the document with the same mac-ocr Vision path Stage 1 uses and write
 * the text to a `<file>.ocr.txt` sidecar, so Spotlight has a text layer to
 * index for a scan that carries none. Returns the bytes written and the
 * sidecar path.
 */
export async function addOcrTextLayer(file: string): Promise<{ bytes: number; sidecar: string }> {
  const ocr = await ocrPages([file])
  if (ocr.chars === 0) {
    throw new Error(`addOcrTextLayer: Vision OCR found no text in ${file}`)
  }
  const sidecar = `${file}.ocr.txt`
  const bytes = await Bun.write(sidecar, ocr.text)
  return { bytes, sidecar }
}
