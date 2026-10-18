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

const jsonPath = new URL('../docnamer.json', import.meta.url).pathname

test('config: src/config.ts exports loadConfig', async () => {
  const mod = await importConfig()
  expect(mod).not.toBeNull()
  expect(typeof mod?.loadConfig).toBe('function')
})

test('config: docnamer.json is shipped, non-empty and parses as JSON', async () => {
  const text = await readRepoFile('docnamer.json')
  expect(text).not.toBeNull()
  expect((text ?? '').trim().length).toBeGreaterThan(0)
  const parsed = JSON.parse(text ?? '') as Record<string, unknown>
  expect(Object.keys(parsed)).toContain('types')
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
  const config = loadConfig(jsonPath)

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
  expect(names.length).toBe(16)
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

test('config: the folder config is docnamer.json and no other name', async () => {
  const cli = (await import('../src/cli.ts')) as {
    configFor: (folder: string) => Promise<{ types: Record<string, unknown> }>
  }
  expect(typeof cli.configFor).toBe('function')

  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-config-${crypto.randomUUID()}`
  Bun.spawnSync(['mkdir', '-p', dir])

  // The folder's own config is honoured under the one shipped name.
  await Bun.write(`${dir}/docnamer.json`, await Bun.file(jsonPath).text())
  const honoured = await cli.configFor(dir)
  expect(Object.keys(honoured.types)).toContain('bank_statement')

  // A folder carrying only the old YAML name is NOT a config location any more.
  // One file, one location: a stale docnamer.yaml must not be read at all.
  Bun.spawnSync(['rm', `${dir}/docnamer.json`])
  await Bun.write(
    `${dir}/docnamer.yaml`,
    [
      'types:',
      '  bogus:',
      '    describe: never read',
      '    fields: {}',
      '    template: bogus'
    ].join('\n')
  )
  const ignored = await cli.configFor(dir)
  expect(Object.keys(ignored.types)).not.toContain('bogus')
})

test('config: a folder with no docnamer.json is planned by the shipped roster itself', async () => {
  const cli = (await import('../src/cli.ts')) as {
    configFor: (folder: string) => Promise<Record<string, unknown>>
  }
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-config-${crypto.randomUUID()}`
  Bun.spawnSync(['mkdir', '-p', dir])

  // One shipped binary, usable on any folder: the roster it was built from IS
  // the config for a folder that carries none. There is no second, thinner
  // config for the no-file case, so a folder without docnamer.json plans with
  // the same 16 types, the same real models and the same entities as one that
  // carries a copy of the shipped file.
  const shipped = await cli.configFor(dir)
  const built = JSON.parse(await Bun.file(jsonPath).text()) as Record<string, unknown>
  expect(shipped).toEqual(built)
})
