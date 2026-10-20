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

  // The roster is pinned to the FILE, not to a number typed in here: a count
  // only records what the file happened to hold the day it was written, while
  // this fails the moment the loader stops returning what the file declares.
  const shipped = JSON.parse((await readRepoFile('docnamer.json')) ?? '') as {
    types: Record<string, unknown>
  }
  const names = Object.keys(config.types)
  expect(names, 'loadConfig must return exactly the types the shipped file declares').toEqual(
    Object.keys(shipped.types)
  )
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

  // The folder's own config is honoured under the one shipped name. The sentinel
  // roster shares no type name with the shipped one, because src/cli.ts's fallback
  // IS the shipped file: `bank_statement` is in both, so it cannot tell them apart.
  const sentinel = {
    types: { sentinel_x: { describe: 'from the folder', fields: {}, template: 'sentinel_x' } }
  }
  await Bun.write(`${dir}/docnamer.json`, JSON.stringify(sentinel))
  const honoured = await cli.configFor(dir)
  expect(Object.keys(honoured.types)).toContain('sentinel_x')
  expect(Object.keys(honoured.types)).not.toContain('bank_statement')

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
  // Refusing the YAML is half of it: the folder must then fall back to the shipped
  // roster, not to some thinner config for the no-file case.
  expect(Object.keys(ignored.types)).toContain('bank_statement')
})

test('config: a folder with no docnamer.json is planned by the shipped roster itself', async () => {
  const cli = (await import('../src/cli.ts')) as {
    configFor: (folder: string) => Promise<Record<string, unknown>>
  }
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/docnamer-config-${crypto.randomUUID()}`
  Bun.spawnSync(['mkdir', '-p', dir])

  // One shipped binary, usable on any folder: the roster it was built from IS
  // the config for a folder that carries none. There is no second, thinner
  // config for the no-file case — the very same object answers, which is what
  // identity pins and a re-parse of the same file could not (content rot would
  // move both sides together).
  const { BUILTIN_CONFIG } = (await import('../src/config.ts')) as {
    BUILTIN_CONFIG: Record<string, unknown>
  }
  const shipped = await cli.configFor(dir)
  expect(shipped).toBe(BUILTIN_CONFIG)
})
