// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference =
  process.env.GRAPH_REFERENCE ??
  'python3 -c "print(\'passport|IND|about six words|not a photo|(2)\')"'

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

const truth = (): string[] => {
  const r = spawnSync(reference, { shell: true, encoding: 'utf8' })
  expect(r.status, r.stderr || r.stdout).toBe(0)
  const line = (r.stdout ?? '').trim()
  const parts = line.split('|')
  expect(
    parts.length,
    `reference did not print the token line: ${JSON.stringify(line)}`
  ).toBeGreaterThan(1)
  return parts
}

/** Minimal config the current prompt reads. Cast at the call: the export may not exist yet. */
const config = {
  entities: { Jacqui: ['Jac'] },
  defaults: { date_order: 'day-first' as const, date_format: 'YYYY-MM-DD' },
  types: { invoice: { description: 'an invoice', fields: { number: { description: 'number' } } } }
}

type BuildPrompt = (content: { text: string }, fileName: string, cfg: typeof config) => string

test('prompt copies silent filename tokens and keeps document screenshots', async () => {
  let buildPrompt: BuildPrompt | undefined
  try {
    const mod = (await import('../src/analyse.ts')) as unknown as {
      buildPrompt?: BuildPrompt
    }
    buildPrompt = mod.buildPrompt
  } catch (e) {
    expect(e, 'src/analyse.ts failed to load').toBeUndefined()
  }
  expect(typeof buildPrompt, 'buildPrompt is not exported from src/analyse.ts').toBe('function')
  if (typeof buildPrompt !== 'function') return

  const fileName = 'silent-page.pdf'
  const prompt = buildPrompt(
    { text: 'page text with no version, status, person, or agency' },
    fileName,
    config
  )
  expect(typeof prompt, 'buildPrompt did not return a string').toBe('string')

  expect(prompt.includes(`"${fileName}"`), 'prompt must still quote fileName').toBe(true)
  expect(
    prompt.toLowerCase().includes('verbatim'),
    'prompt must still require verbatim page evidence'
  ).toBe(true)

  for (const part of truth()) {
    expect(
      prompt.includes(part),
      `prompt missing reference instruction ${JSON.stringify(part)}`
    ).toBe(true)
  }

  expect(prompt.includes('REISEPASS'), 'passport type word must forbid REISEPASS').toBe(true)
  expect(
    prompt.includes('Immigration And Naturalisation Service'),
    'agency instruction must name the full ministry title it replaces with the short name'
  ).toBe(true)
  expect(
    prompt.toLowerCase().includes('silent'),
    'prompt must say to copy filename tokens when the page is silent'
  ).toBe(true)
  expect(prompt.includes('version'), 'prompt must name version among filename tokens').toBe(true)
  expect(prompt.includes('status'), 'prompt must name status among filename tokens').toBe(true)
  expect(prompt.includes('person'), 'prompt must name person among filename tokens').toBe(true)
  expect(prompt.includes('other'), 'a document screenshot must not be typed other').toBe(true)
})
