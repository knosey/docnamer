import { expect, test } from 'bun:test'
import { copyFileSync } from 'node:fs'
import { repo, resolveCli } from './doc-renamer-apply-harness.ts'
import { hasPty, makeTerminal } from './pty.ts'
import { scratch } from './scratch.ts'

// A `Bun.spawnSync` on the plan path blocks the thread, so the 80ms spinner
// interval cannot paint. These drive real `plan` and sample the screen twice
// while the child under test is still alive. A sleep beside a fake spinner does
// not count: the second sample is taken only if that child has not exited.
// The OCR fixture is a 4-page image PDF with no text operators. The sips fixture
// is receipt.png scaled to 8000px: a normal scan rasterizes in under one tick.

const FIXTURE = `${repo}/tests/fixtures/ocr-stall.pdf`
const SCAN = 'scan.pdf'

const FRAMES = new Set([
  '\u280b',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283c',
  '\u2834',
  '\u2826',
  '\u2827',
  '\u2807',
  '\u280f',
  '|',
  '/',
  '-',
  '\\'
])

function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env.HOME = home
  env.TERM = 'xterm-256color'
  delete env.NO_COLOR
  delete env.FIREWORKS_API_KEY
  delete env.XDG_CONFIG_HOME
  return env
}

function firstLine(screen: string): string {
  for (const line of screen.split('\n')) {
    if (line.trim().length > 0) return line
  }
  throw new Error(`blank screen: ${JSON.stringify(screen)}`)
}

function glyphOf(line: string): string {
  const point = line.trimStart().codePointAt(0)
  if (point === undefined) throw new Error(`no glyph on ${JSON.stringify(line)}`)
  return String.fromCodePoint(point)
}

function ocrPids(file: string): number[] {
  const proc = Bun.spawnSync(['ps', '-axo', 'pid,command'])
  if (proc.exitCode !== 0) {
    throw new Error(`ps exited ${proc.exitCode}: ${proc.stderr.toString()}`)
  }
  const pids: number[] = []
  for (const line of proc.stdout.toString().split('\n')) {
    if (!line.includes(file) || !line.includes('docnamer-mac-ocr')) continue
    const pid = Number(line.trim().split(' ', 1)[0])
    if (!Number.isInteger(pid)) throw new Error(`ps line had no pid: ${line}`)
    pids.push(pid)
  }
  return pids
}

function stopOcr(file: string): void {
  for (const pid of ocrPids(file)) process.kill(pid, 'SIGTERM')
}

function sipsPids(file: string): number[] {
  const proc = Bun.spawnSync(['ps', '-axo', 'pid,command'])
  if (proc.exitCode !== 0) {
    throw new Error(`ps exited ${proc.exitCode}: ${proc.stderr.toString()}`)
  }
  const pids: number[] = []
  for (const line of proc.stdout.toString().split('\n')) {
    if (!line.includes(file) || !line.includes('sips')) continue
    const pid = Number(line.trim().split(' ', 1)[0])
    if (!Number.isInteger(pid)) throw new Error(`ps line had no pid: ${line}`)
    pids.push(pid)
  }
  return pids
}

function stopSips(file: string): void {
  for (const pid of sipsPids(file)) process.kill(pid, 'SIGTERM')
}

function scaledScan(dir: string): string {
  const png = `${scratch('docnamer-sips-src')}/page.png`
  const file = `${dir}/${SCAN}`
  const up = Bun.spawnSync([
    'sips',
    '-z',
    '8000',
    '8000',
    `${repo}/tests/fixtures/receipt.png`,
    '--out',
    png
  ])
  if (up.exitCode !== 0) {
    throw new Error(`could not scale receipt.png: ${up.stderr.toString()}`)
  }
  const pdf = Bun.spawnSync(['sips', '-s', 'format', 'pdf', png, '--out', file])
  if (pdf.exitCode !== 0) {
    throw new Error(`could not wrap the scaled page as a pdf: ${pdf.stderr.toString()}`)
  }
  return file
}

test('Bun.Terminal is present, so the spinner sample runs rather than skips', () => {
  expect(hasPty, 'Bun.Terminal is absent; the spinner sample would skip and stay green').toBe(true)
})

test.skipIf(!hasPty)(
  'plan spinner glyph changes while mac-ocr is still reading the first file',
  async () => {
    const dir = scratch('docnamer-spinner-ocr')
    const home = scratch('docnamer-spinner-home')
    const file = `${dir}/${SCAN}`
    copyFileSync(FIXTURE, file)
    const cli = await resolveCli()
    if (cli === null) throw new Error('plan-spinner: no docnamer CLI to drive')
    const term = makeTerminal()
    const proc = Bun.spawn([...cli, 'plan', dir], {
      terminal: term.terminal,
      cwd: dir,
      env: cleanEnv(home)
    })
    try {
      const started = Date.now()
      while (ocrPids(file).length === 0) {
        if (proc.exitCode !== null) {
          throw new Error(
            `plan exited ${proc.exitCode} before mac-ocr started: ${JSON.stringify(await term.screen())}`
          )
        }
        if (Date.now() - started > 12000) {
          throw new Error(
            `mac-ocr never started on ${file}: ${JSON.stringify(await term.screen())}`
          )
        }
        await Bun.sleep(15)
      }
      const first = firstLine(await term.screen())
      await Bun.sleep(200)
      if (ocrPids(file).length === 0) {
        throw new Error(
          'mac-ocr exited before the second sample; the fixture is too fast to prove the stall'
        )
      }
      const second = firstLine(await term.screen())
      const before = glyphOf(first)
      const after = glyphOf(second)
      expect(
        FRAMES.has(before),
        `first paint was not a spinner frame: ${JSON.stringify(first)}`
      ).toBe(true)
      expect(first.toLowerCase()).toContain('analysing the documents')
      expect(
        after,
        `spinner glyph frozen while mac-ocr still running: ${JSON.stringify(second)}`
      ).not.toBe(before)
    } finally {
      stopOcr(file)
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, Bun.sleep(3000)])
      term.terminal.close()
    }
  },
  20000
)

test.skipIf(!hasPty)(
  'plan spinner glyph changes while sips is still rasterizing the first file',
  async () => {
    const dir = scratch('docnamer-spinner-sips')
    const home = scratch('docnamer-spinner-home')
    const file = scaledScan(dir)
    const cli = await resolveCli()
    if (cli === null) throw new Error('plan-spinner: no docnamer CLI to drive')
    const term = makeTerminal()
    const proc = Bun.spawn([...cli, 'plan', dir], {
      terminal: term.terminal,
      cwd: dir,
      env: cleanEnv(home)
    })
    try {
      const started = Date.now()
      while (sipsPids(file).length === 0) {
        if (proc.exitCode !== null) {
          throw new Error(
            `plan exited ${proc.exitCode} before sips started: ${JSON.stringify(await term.screen())}`
          )
        }
        if (Date.now() - started > 15000) {
          throw new Error(`sips never started on ${file}: ${JSON.stringify(await term.screen())}`)
        }
        await Bun.sleep(15)
      }
      const first = firstLine(await term.screen())
      await Bun.sleep(200)
      if (sipsPids(file).length === 0) {
        throw new Error(
          'sips exited before the second sample; the page is too fast to prove the stall'
        )
      }
      const second = firstLine(await term.screen())
      const before = glyphOf(first)
      const after = glyphOf(second)
      expect(
        FRAMES.has(before),
        `first paint was not a spinner frame: ${JSON.stringify(first)}`
      ).toBe(true)
      expect(first.toLowerCase()).toContain('analysing the documents')
      expect(
        after,
        `spinner glyph frozen while sips still running: ${JSON.stringify(second)}`
      ).not.toBe(before)
    } finally {
      stopSips(file)
      stopOcr(file)
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, Bun.sleep(3000)])
      term.terminal.close()
    }
  },
  30000
)
