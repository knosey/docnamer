// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference =
  process.env.GRAPH_REFERENCE ?? 'python3 -c "print(\'v3|V4|draft|Jacqui|Jac|IND|100|120|(2)\')"'

import { expect, test } from 'bun:test'

/**
 * src/name.ts is loaded inside each check, never at the top of the file, so a missing module or
 * export is a failed check this suite reports — not a throw at load.
 *
 * The reference prints `v3|V4|draft|Jacqui|Jac|IND|100|120|(2)`: version tokens (casing kept),
 * the status word, person tokens, the agency short form, the photo/other cap, max_name_length,
 * and the Finder clash suffix.
 */

type Field = { value: string | null; evidence: string | null }
type Checked = {
  type: string
  type_confidence: number
  fields: Record<string, Field>
  summary: string
  flags: string[]
}
type Config = {
  defaults: { max_name_length: number }
  types: Record<string, { template: string }>
}
type Tokens = { version: string | null; status: string | null; person: string | null }
type NameModule = {
  tokensFromName?: (fileName: string) => Tokens
  buildName(
    checked: Checked,
    config: Config,
    file: { dir: string; ext: string; name?: string },
    planned: Set<string>
  ): Promise<string>
  renderTemplate(t: string, fields: Record<string, string>): string
  sanitise(s: string): string
}

const parseArgv = (cmd: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

const referenceOutput = (): string => {
  const argv = parseArgv(reference)
  if (!argv.length) throw new Error('reference is empty')
  const bin = Bun.which(argv[0] ?? '') ?? argv[0] ?? ''
  const p = Bun.spawnSync([bin, ...argv.slice(1)])
  if (p.exitCode !== 0) {
    throw new Error(`reference exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
  return p.stdout.toString().trim()
}

const truth = (): string[] => {
  const parts = referenceOutput().split('|')
  if (parts.length !== 9) {
    throw new Error(`reference must print 9 |-fields, got ${JSON.stringify(referenceOutput())}`)
  }
  return parts
}

const loadName = async (): Promise<NameModule> => {
  try {
    return (await import('../src/name.ts')) as unknown as NameModule
  } catch (e) {
    throw new Error('src/name.ts is not written: ' + ((e as Error)?.message ?? String(e)))
  }
}

const tokensOf = async (fileName: string): Promise<Tokens> => {
  const mod = await loadName()
  if (typeof mod.tokensFromName !== 'function') {
    throw new Error('tokensFromName is not written')
  }
  return mod.tokensFromName(fileName)
}

const field = (value: string | null): Field => ({ value, evidence: null })

const checked = (type: string, fields: Record<string, string | null>): Checked => ({
  type,
  type_confidence: 1,
  fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, field(v)])),
  summary: 'summary',
  flags: []
})

const config = (max: number, types: Record<string, string>): Config => ({
  defaults: { max_name_length: max },
  types: Object.fromEntries(Object.entries(types).map(([k, template]) => [k, { template }]))
})

const build = async (
  c: Checked,
  cfg: Config,
  file: { dir: string; ext: string; name?: string },
  planned: Set<string> = new Set()
): Promise<string> => {
  const mod = await loadName()
  return mod.buildName(c, cfg, file, planned)
}

test('tokensFromName keeps version casing and ignores a Finder suffix', async () => {
  const [vLow, vUp, status, personFull, personShort, , , , clash] = truth()
  const low = await tokensOf(`dir/ignored ${vLow}/20260006 Crowdbuilding February ${vLow}.pdf`)
  const up = await tokensOf(`20260006 Crowdbuilding ${vUp}.pdf`)
  const suffixed = await tokensOf(`scan ${clash}.pdf`)
  expect(low.version).toBe(vLow)
  expect(up.version).toBe(vUp)
  expect(suffixed.version).toBeNull()
  expect(status).toBeTruthy()
  expect(personFull).toBeTruthy()
  expect(personShort).toBeTruthy()
})

test('tokensFromName reads status and person tokens from the basename', async () => {
  const [, , status, personFull, personShort] = truth()
  const draft = await tokensOf(`folder/${status.toUpperCase()}/notes ${status}.pdf`)
  const full = await tokensOf(`passport-${personFull.toLowerCase()}-with-stamps.pdf`)
  const short = await tokensOf(`Authority-${personShort}-EEAVISA.pdf`)
  const tm = await tokensOf('receipt TM.pdf')
  const none = await tokensOf('plain.pdf')
  expect(draft.status).toBe(status)
  expect(draft.version).toBeNull()
  expect(full.person).toBe(personFull)
  expect(short.person).toBe(personShort)
  expect(full.person).not.toBe(personShort)
  expect(tm.person).toBe('TM')
  expect(none.person).toBeNull()
  expect(none.status).toBeNull()
})

test('buildName fills empty version, status and person from file.name', async () => {
  const [vLow, , status, personFull, , , , maxLen] = truth()
  const max = Number(maxLen)
  const name = await build(
    checked('invoice', {
      date: '2026-02-01',
      version: '',
      status: '',
      person: '',
      subject: 'Crowdbuilding'
    }),
    config(max, { invoice: '{date} {person} {subject} {version} {status}' }),
    { dir: '/docs', ext: '.pdf', name: `20260006 ${personFull} ${status} ${vLow}.pdf` }
  )
  expect(name).toContain(vLow)
  expect(name).toContain(status)
  expect(name).toContain(personFull)
})

test('passport with an empty holder takes the person token', async () => {
  const [, , , personFull, , , , maxLen] = truth()
  const name = await build(
    checked('passport', { date: '2024-01-02', holder: '', kind: 'passport' }),
    config(Number(maxLen), { passport: '{date} {holder} passport' }),
    { dir: '/docs', ext: '.pdf', name: `passport-${personFull.toLowerCase()}-with-stamps.pdf` }
  )
  expect(name).toBe(`2024-01-02 ${personFull} passport.pdf`)
})

test('agency rendering shortens the ministry and keeps a first word otherwise', async () => {
  const [, , , , , agency, , maxLen] = truth()
  const max = Number(maxLen)
  const ind = await build(
    checked('letter', {
      date: '2024-03-01',
      person: 'Jac',
      kind: 'visa',
      agency: 'Immigration And Naturalisation Service'
    }),
    config(max, { letter: '{date} {person} {kind} {agency}' }),
    { dir: '/docs', ext: '.pdf', name: 'Authority-Jac-EEAVISA.pdf' }
  )
  const other = await build(
    checked('letter', {
      date: '2024-03-01',
      person: 'Jac',
      kind: 'visa',
      agency: 'Belastingdienst Toeslagen'
    }),
    config(max, { letter: '{date} {person} {kind} {agency}' }),
    { dir: '/docs', ext: '.pdf' }
  )
  expect(ind).toBe(`2024-03-01 Jac visa ${agency}.pdf`)
  expect(ind).not.toContain('Immigration And Naturalisation Service')
  expect(other).toBe('2024-03-01 Jac visa Belastingdienst.pdf')
})

test('photo and other cap below max_name_length; a real clash still suffixes', async () => {
  const [, , , , , , photoCap, maxLen, clash] = truth()
  const cap = Number(photoCap)
  const max = Number(maxLen)
  const subject = 'word '.repeat(40).trim()
  const cfg = config(max, {
    photo: '{subject} {number}',
    other: '{subject}',
    invoice: '{subject} {number}'
  })
  const photo = await build(checked('photo', { subject, number: '99999' }), cfg, {
    dir: '/docs',
    ext: '.jpg',
    name: 'IMG_0001.jpg'
  })
  const other = await build(checked('other', { subject }), cfg, { dir: '/docs', ext: '.pdf' })
  const invoice = await build(
    checked('invoice', { subject: 'word '.repeat(20).trim(), number: '12' }),
    cfg,
    { dir: '/docs', ext: '.pdf' }
  )
  const again = await build(
    checked('invoice', { subject: 'word '.repeat(20).trim(), number: '12' }),
    cfg,
    { dir: '/docs', ext: '.pdf' },
    new Set([invoice])
  )
  expect(photo.length).toBeLessThanOrEqual(cap)
  expect(other.length).toBeLessThanOrEqual(cap)
  expect(invoice.length).toBeLessThanOrEqual(max)
  expect(invoice.length).toBeGreaterThan(cap)
  expect(photo.endsWith('.jpg')).toBe(true)
  expect(again).toBe(invoice.replace(/\.pdf$/, ` ${clash}.pdf`))
})

test('the photo/other cap never lifts above a configured max_name_length', async () => {
  const [, , , , , , photoCap] = truth()
  const cap = Number(photoCap)
  const max = cap - 40
  const subject = 'word '.repeat(40).trim()
  const other = await build(checked('other', { subject }), config(max, { other: '{subject}' }), {
    dir: '/docs',
    ext: '.pdf'
  })
  const photo = await build(checked('photo', { subject }), config(max, { photo: '{subject}' }), {
    dir: '/docs',
    ext: '.jpg'
  })
  expect(other.length).toBeLessThanOrEqual(max)
  expect(photo.length).toBeLessThanOrEqual(max)
})

test('length clamp drops subject words then number before slicing', async () => {
  const [, , , , , , , maxLen] = truth()
  const max = Number(maxLen)
  const kept = ['alpha', 'bravo', 'charlie', 'delta', 'echo']
  const padded = `${kept.join(' ')} ${'zz'.repeat(80)}`
  const name = await build(
    checked('invoice', { subject: padded, number: '99999' }),
    config(max, { invoice: '{subject} {number}' }),
    { dir: '/docs', ext: '.pdf' }
  )
  const base = name.slice(0, -'.pdf'.length)
  expect(name.length).toBeLessThanOrEqual(max)
  expect(base.includes('alpha')).toBe(true)
  expect(base.includes('zz')).toBe(false)
  expect(base.split(' ').every(w => kept.includes(w) || w === '99999')).toBe(true)
})

test('commands.ts and review.ts pass file.name into buildName', async () => {
  const read = async (path: string): Promise<string> => {
    const f = Bun.file(path)
    if (!(await f.exists())) throw new Error(`${path} is not written`)
    return f.text()
  }
  const commands = await read('src/commands.ts')
  const review = await read('src/review.ts')
  const call = (src: string): string => {
    const i = src.indexOf('buildName(')
    if (i < 0) throw new Error('buildName( is not written')
    return src.slice(i, i + 400)
  }
  expect(call(commands)).toContain('name:')
  expect(call(review)).toContain('name:')
})
