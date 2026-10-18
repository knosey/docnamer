import { test, expect } from 'bun:test'

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
