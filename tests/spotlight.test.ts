// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`ls tests/fixtures`

// T1 — Spotlight extras: Finder tags, comments and the OCR text layer.
//
// src/spotlight.ts is the work under test; until it exists every case below
// fails on its own check (a null import or a missing export), never on a throw
// at load. The fixtures the cases run against are the files the reference
// command names, so a swapped GRAPH_REFERENCE changes which files — and which
// verdict — the suite reports.

import { test, expect } from 'bun:test'
import { scratch } from './scratch.ts'

/** The reference's output lines, or [] when it cannot run — a failed check, never a throw. */
function referenceLines(): string[] {
  const proc = Bun.spawnSync(['/bin/sh', '-c', reference])
  if (proc.exitCode !== 0) return []
  return proc.stdout
    .toString()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** The directory the reference lists, resolved against the repo root. */
function referenceDir(): URL {
  const dir = reference.trim().split(/\s+/).pop() ?? 'tests/fixtures'
  return new URL(`../${dir}/`, import.meta.url)
}

/** Import src/spotlight.ts, or null when it is not there yet. */
async function importSpotlight(): Promise<Record<string, unknown> | null> {
  try {
    return (await import('../src/spotlight.ts')) as Record<string, unknown>
  } catch {
    return null
  }
}

const folder = scratch('spotlight')

test('spotlight: src/spotlight.ts exports the T1 interface', async () => {
  const mod = await importSpotlight()
  expect(mod).not.toBeNull()
  for (const name of [
    'setFinderTag',
    'readFinderTags',
    'setFinderComment',
    'addOcrTextLayer',
    'encodeTagPlist',
    'decodeTagPlist'
  ]) {
    expect(typeof mod?.[name]).toBe('function')
  }
})

test('spotlight: the reference names fixture files the cases run against', () => {
  const names = referenceLines()
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) {
    expect(Bun.file(new URL(name, referenceDir())).size).toBeGreaterThan(0)
  }
})

test('spotlight: encodeTagPlist/decodeTagPlist round-trip Finder tags', async () => {
  const mod = await importSpotlight()
  expect(mod).not.toBeNull()
  const encode = mod?.encodeTagPlist as (tags: string[]) => Uint8Array
  const decode = mod?.decodeTagPlist as (bytes: Uint8Array) => string[]
  const tags = ['Red', 'Project X']
  const bytes = encode(tags)
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect(bytes.length).toBeGreaterThan(0)
  expect(decode(bytes)).toEqual(tags)
})

test('spotlight: setFinderTag/readFinderTags round-trip on a fixture copy', async () => {
  const mod = await importSpotlight()
  expect(mod).not.toBeNull()
  const name = referenceLines()[0] ?? ''
  const file = `${folder}/${name}`
  await Bun.write(file, await Bun.file(new URL(name, referenceDir())).bytes())
  const setFinderTag = mod?.setFinderTag as (f: string, tag: string) => Promise<void>
  const readFinderTags = mod?.readFinderTags as (f: string) => Promise<string[]>
  await setFinderTag(file, 'Red')
  const tags = await readFinderTags(file)
  expect(tags).toContain('Red')
})

test('spotlight: setFinderComment resolves for a fixture copy', async () => {
  const mod = await importSpotlight()
  expect(mod).not.toBeNull()
  const name = referenceLines()[0] ?? ''
  const file = `${folder}/comment-${name}`
  await Bun.write(file, await Bun.file(new URL(name, referenceDir())).bytes())
  const setFinderComment = mod?.setFinderComment as (f: string, comment: string) => Promise<void>
  await expect(setFinderComment(file, 'renamed by docnamer')).resolves.toBeUndefined()
})

test('spotlight: addOcrTextLayer reports the bytes it wrote and its sidecar', async () => {
  const mod = await importSpotlight()
  expect(mod).not.toBeNull()
  const name = referenceLines().find(n => n.endsWith('.pdf')) ?? ''
  const file = `${folder}/${name}`
  await Bun.write(file, await Bun.file(new URL(name, referenceDir())).bytes())
  const addOcrTextLayer = mod?.addOcrTextLayer as (
    f: string
  ) => Promise<{ bytes: number; sidecar: string }>
  const result = await addOcrTextLayer(file)
  expect(typeof result.bytes).toBe('number')
  expect(result.bytes).toBeGreaterThan(0)
  expect(typeof result.sidecar).toBe('string')
})
