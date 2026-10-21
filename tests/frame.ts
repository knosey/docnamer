/**
 * The visual evidence writer (visual-evidence-doctrine, Tier 1).
 *
 * A CLI feature has no window to screenshot, so its frame is the CLI's own
 * stdout put through the real text pipeline and rasterised:
 *
 *   text -> SVG (monospace, xml:space="preserve", one <text> per line) -> sips -> PNG
 *
 * One <text> element per line, never a wrapped paragraph: the line breaks a
 * person reads in a terminal are the ones in the frame.
 *
 * xml:space="preserve" keeps the padding BETWEEN columns, which is what makes a
 * table legible. It does NOT keep the indent that STARTS a line: sips strips a
 * text run's leading whitespace regardless, which would render the marked rows
 * two characters right of the rest. A line's leading indent is therefore emitted
 * as geometry (the run's x) and the run itself is left-trimmed.
 *
 * The judge reads every .png under .audit/screenshots/ (the graph's capture node
 * clears and counts that directory), so the frame lands there and nowhere else.
 * Test-only: it shells out to sips and is never imported by src/.
 *
 * MEASURED, because a vision judge read the frames as ligating `--` into one
 * em-dash glyph: sips does not. Four bare dash runs through this exact pipeline
 * and back out of the BMP as ink columns give `--` 2 runs (6px + 7px, 14px
 * span), `-` 1 run of 6px, `---` 3 runs, and U+2014 1 run of 8px. Two adjacent
 * hyphens at 13px simply read as one long dash to a vision model, and the
 * ASCII in the SVG is what the parser sees. Re-measure before changing the
 * font stack: rasterise `['--', '\u2014', '-', '---']` and count the runs.
 */
import { scratch } from './scratch.ts'

const FRAMES_DIR = '.audit/screenshots'

/** Menlo at 13px. The SVG box is sized from these, so nothing is clipped. */
const CHAR_W = 7.9
const LINE_H = 18
const PAD = 12
const FONT_SIZE = 13

const repo = import.meta.dir.replace(/\/tests$/, '')

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * C0 control bytes other than tab and newline, built from char codes the way
 * tests/pty.ts's ANSI constant is, so no-control-regex stays quiet. A captured
 * pty frame can carry a bare backspace byte (zsh's prompt redraw), and a bare
 * C0 byte is invalid XML 1.0, so sips refuses the raster.
 */
const C0 = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}]`,
  'g'
)

/** The stdout as an SVG image, one <text> per line so nothing re-wraps. */
function toSvg(text: string): string {
  const lines = text.replace(C0, '').replace(/\n+$/, '').split('\n')
  let cols = 0
  for (const l of lines) if (l.length > cols) cols = l.length
  const w = Math.ceil(cols * CHAR_W) + PAD * 2
  const h = lines.length * LINE_H + PAD * 2
  const body = lines
    .map((l, i) => {
      const lead = l.length - l.trimStart().length
      return (
        `<text x="${PAD + lead * CHAR_W}" y="${PAD + (i + 1) * LINE_H - 4}" ` +
        `font-family="Menlo, monospace" font-size="${FONT_SIZE}" ` +
        `fill="#e6e6e6" xml:space="preserve">${esc(l.trimStart())}</text>`
      )
    })
    .join('\n  ')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">\n` +
    `  <rect width="${w}" height="${h}" fill="#101014"/>\n` +
    `  ${body}\n</svg>\n`
  )
}

/**
 * Rasterise `text` to `<repo>/.audit/screenshots/<name>.png` and return the
 * path. Throws when the raster is missing or empty: a frame the judge cannot
 * open is worse than no frame, because capture counts it.
 */
export async function frame(text: string, name: string): Promise<string> {
  if (!text.trim()) throw new Error(`frame ${name}: nothing to render, stdout was empty`)
  const svgText = toSvg(text)
  // The regression guard for the ragged table. sips strips whitespace that
  // STARTS a run, so a run must never begin with one — the rows carrying a "!"
  // margin rendered two characters right of the rest, and a column nobody can
  // read down is what made the judge misread the names in it.
  if (/<text[^>]*>\s/.test(svgText)) {
    throw new Error(`frame ${name}: a <text> run begins with whitespace; indent must be its x`)
  }
  const dir = `${repo}/${FRAMES_DIR}`
  // sips does not create missing parent directories, and .audit/ is gitignored,
  // so on a fresh clone the directory is not there. The graph's capture node
  // makes it, but this writer must not depend on who called it.
  const mk = Bun.spawnSync(['mkdir', '-p', dir])
  if (mk.exitCode !== 0) {
    throw new Error(`frame ${name}: mkdir -p ${dir} failed: ${mk.stderr.toString().trim()}`)
  }
  const out = `${dir}/${name}.png`
  // A predictable name in a shared TMPDIR is a symlink target. Unique per call,
  // and in a scratch directory, so the intermediate is not left behind either.
  const svg = `${scratch('docnamer-frame')}/frame.svg`
  await Bun.write(svg, svgText)
  const p = Bun.spawnSync(['sips', '-s', 'format', 'png', svg, '--out', out])
  if (p.exitCode !== 0) {
    throw new Error(`frame ${name}: sips failed (${p.exitCode}): ${p.stderr.toString().trim()}`)
  }
  const f = Bun.file(out)
  if (!(await f.exists()) || f.size === 0)
    throw new Error(`frame ${name}: ${out} is missing or empty`)
  return out
}
