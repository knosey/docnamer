// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun --version`

import { test, expect } from 'bun:test'

/** Run this node's reference command; the verdict must follow its output. */
function runReference(): { code: number; out: string } {
  const proc = Bun.spawnSync(['sh', '-c', reference])
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString().trim() }
}

/** Read a repo-root file, or null when it is not there yet — a failed check, never a throw. */
async function readRepoFile(name: string): Promise<string | null> {
  const file = Bun.file(new URL(`../${name}`, import.meta.url))
  return (await file.exists()) ? await file.text() : null
}

/** Import the config module, or null when it is not there yet. */
async function importConfig(): Promise<Record<string, unknown> | null> {
  try {
    return (await import('../src/config.ts')) as Record<string, unknown>
  } catch {
    return null
  }
}

const yamlPath = new URL('../docnamer.yaml', import.meta.url).pathname

test('reference: the runtime probe exits 0 with a version', () => {
  const { code, out } = runReference()
  expect(code).toBe(0)
  expect(out).toMatch(/^\d+\.\d+\.\d+/)
})

test('config: src/config.ts exports loadConfig', async () => {
  const mod = await importConfig()
  expect(mod).not.toBeNull()
  expect(typeof mod?.loadConfig).toBe('function')
})

test('config: docnamer.yaml is shipped and non-empty', async () => {
  const text = await readRepoFile('docnamer.yaml')
  expect(text).not.toBeNull()
  expect((text ?? '').trim().length).toBeGreaterThan(0)
})

test('config: loadConfig returns the shipped Config', async () => {
  const mod = await importConfig()
  expect(mod).not.toBeNull()
  const loadConfig = mod?.loadConfig as (p: string) => {
    defaults: {
      date_format: string
      date_order: string
      max_name_length: number
      ocr_text_layer: boolean
      finder_tags: boolean
      finder_comment: boolean
    }
    models: { cheap: string; vision: string; strong: string }
    types: Record<
      string,
      {
        describe: string
        fields: Record<string, { kind: string; required: boolean }>
        template: string
      }
    >
    entities: Record<string, string[]>
  }
  const config = loadConfig(yamlPath)

  expect(typeof config.defaults.date_format).toBe('string')
  expect(['day-first', 'month-first']).toContain(config.defaults.date_order)
  expect(typeof config.defaults.max_name_length).toBe('number')
  expect(typeof config.defaults.ocr_text_layer).toBe('boolean')
  expect(typeof config.defaults.finder_tags).toBe('boolean')
  expect(typeof config.defaults.finder_comment).toBe('boolean')
  expect(typeof config.models.cheap).toBe('string')
  expect(typeof config.models.vision).toBe('string')
  expect(typeof config.models.strong).toBe('string')
  expect(typeof config.entities).toBe('object')

  const names = Object.keys(config.types)
  expect(names.length).toBe(15)
  expect(names).toContain('other')
  for (const name of names) {
    const t = config.types[name]!
    expect(typeof t.describe).toBe('string')
    expect(typeof t.template).toBe('string')
    for (const field of Object.values(t.fields)) {
      expect(['text', 'date', 'entity', 'last4']).toContain(field.kind)
      expect(typeof field.required).toBe('boolean')
    }
  }
})
