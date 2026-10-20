import { expect, test } from 'bun:test'
import { runChild } from './child.ts'
import { repo, resolveCli } from './doc-renamer-apply-harness.ts'

/**
 * T8 — where docnamer's model credential comes from, with no environment variable.
 *
 * Until now the credential arrived as `FIREWORKS_API_KEY` and nothing else:
 * `completeSimple` from `@earendil-works/pi-ai/compat` resolves a key from the
 * environment (`dist/compat.js:149`), which is why the variable was
 * load-bearing and why a person could not simply sign in. The chain this file
 * pins is the one a person asked for — use the login pi already holds, and only
 * when there is none, hold docnamer's own:
 *
 *   1. `~/.pi/agent/auth.json` — pi's own credential file, which is already a
 *      `Record<providerId, Credential>` (`fireworks` is `{type, key}`, an OAuth
 *      provider is `{type, access, refresh, expires, accountId}`).
 *   2. `~/.config/docnamer/credentials.json` — docnamer's own store, written by
 *      `docnamer login`.
 *
 * Every case runs the real CLI as a subprocess with a throwaway `HOME`, and
 * `FIREWORKS_API_KEY` is DELETED from the environment before each one — so a
 * pass cannot be the variable answering, which is the failure this file exists
 * to make impossible. No model is called: `auth`, `login --help` and
 * `logout --help` all answer before any folder is opened.
 */

/** pi's file as it really is on this machine: an api_key arm and an oauth arm. */
const PI_STORE = {
  fireworks: { type: 'api_key', key: 'pi-held-key' },
  'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 0, accountId: 'acct' }
}

/** docnamer's own store, the same shape, written by `docnamer login`. */
const OWN_STORE = { fireworks: { type: 'api_key', key: 'docnamer-held-key' } }

/** A throwaway HOME, optionally carrying either store. Bun.write makes the parents. */
async function homeWith(pi?: unknown, own?: unknown): Promise<string> {
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? '/tmp'}/docnamer-auth-${crypto.randomUUID()}`
  if (pi !== undefined) await Bun.write(`${dir}/.pi/agent/auth.json`, JSON.stringify(pi))
  if (own !== undefined)
    await Bun.write(`${dir}/.config/docnamer/credentials.json`, JSON.stringify(own))
  return dir
}

/** Run the real CLI with a scrubbed environment: no key, and the given HOME. */
async function cliAs(
  home: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return cliAsTyping(home, undefined, ...args)
}

/**
 * The same, with a line of input on stdin for a flow that asks a question. The
 * environment is scrubbed the same way, so a pass can never be the variable
 * answering.
 */
async function cliAsTyping(
  home: string,
  input: string | undefined,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = await resolveCli()
  if (argv === null) {
    throw new Error('no docnamer reachable: set DOCNAMER_BIN, or build one with `bun run build`')
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v
  delete env.FIREWORKS_API_KEY
  // Both stores resolve under HOME; an inherited XDG_CONFIG_HOME would point
  // docnamer's own store at the real one and make this machine-dependent.
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  return runChild([...argv, ...args], { cwd: repo, env, input })
}

test('auth resolves a credential from pi when the environment carries no key', async () => {
  const r = await cliAs(await homeWith(PI_STORE), 'auth')
  expect(r.code, `auth exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, 'auth did not name the provider the config needs').toContain('fireworks')
  expect(r.stdout, "auth did not say the credential came from pi's file").toContain(
    '.pi/agent/auth.json'
  )
})

test("pi's login wins over docnamer's own store when both are present", async () => {
  const r = await cliAs(await homeWith(PI_STORE, OWN_STORE), 'auth')
  expect(r.code, `auth exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, "the credential was taken from docnamer's store while pi held one").toContain(
    '.pi/agent/auth.json'
  )
})

test("docnamer's own store answers when pi holds no login", async () => {
  const r = await cliAs(await homeWith(undefined, OWN_STORE), 'auth')
  expect(r.code, `auth exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, 'auth did not name the provider the config needs').toContain('fireworks')
  expect(r.stdout, "auth did not say the credential came from docnamer's own store").toContain(
    'docnamer/credentials.json'
  )
})

test('auth fails and points at login when neither store holds a credential', async () => {
  const r = await cliAs(await homeWith(), 'auth')
  // 1, not 2: the invocation was accepted and the run failed. 2 is for an
  // invocation docnamer refused, which this one is not — the two codes are only
  // worth having if something pins each side.
  expect(r.code, 'a run that failed must exit 1, not the refusal code 2').toBe(1)
  expect(r.stdout, 'the failure belongs on stderr, not stdout').toBe('')
  expect(r.stderr, 'the message must say how to get a credential').toContain('login')
})

test('login and logout are real commands with their own help', async () => {
  for (const cmd of ['login', 'logout']) {
    const r = await cliAs(await homeWith(), cmd, '--help')
    expect(r.code, `${cmd} --help exited ${r.code}`).toBe(0)
    expect(r.stdout.trim().length, `${cmd} --help printed nothing`).toBeGreaterThan(0)
  }
  const login = await cliAs(await homeWith(), 'login', '--help')
  expect(login.stdout, 'login --help does not say what it takes').toContain('provider')
})

test('login stores the key it was given, owner-only, and auth then finds it', async () => {
  const home = await homeWith()
  const typed = await cliAsTyping(home, 'typed-in-key\n', 'login', 'fireworks')
  expect(typed.code, `login exited ${typed.code}: ${typed.stderr}`).toBe(0)

  const store = `${home}/.config/docnamer/credentials.json`
  const written: { fireworks?: unknown } = await Bun.file(store).json()
  expect(
    written.fireworks,
    'login stored nothing under the provider it was told to sign in to'
  ).toMatchObject({ type: 'api_key', key: 'typed-in-key' })

  const mode = (await Bun.file(store).stat()).mode & 0o777
  expect(mode.toString(8), 'the stored key is readable by anyone else on the machine').toBe('600')

  const after = await cliAs(home, 'auth')
  expect(after.code, `auth after login exited ${after.code}: ${after.stderr}`).toBe(0)
  expect(after.stdout, 'auth did not see the credential login had just written').toContain(
    'docnamer/credentials.json'
  )
})

/*
 * The picker. `docnamer login` with no provider is a sign-in flow, not a usage error: the list of
 * providers a person may sign in to is the catalog, and choosing one is the first step of the flow
 * rather than a mistake to be corrected. The same goes for `logout`, which can only ever remove
 * docnamer's OWN credential and must say so instead of reporting a success it did not perform.
 */

test('a bare `login` offers the catalog instead of a usage error', async () => {
  const r = await cliAsTyping(await homeWith(PI_STORE), 'q\n', 'login')
  expect(r.code, `login exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, 'a bare login is still a usage error').not.toContain('usage:')
  // The shipped config needs one provider; the list a person picks from is the
  // whole catalog, so a list built from the config alone is the wrong list.
  for (const id of ['fireworks', 'anthropic', 'openai', 'google', 'deepseek']) {
    expect(r.stdout, `the offered list does not include ${id}`).toContain(id)
  }
})

test('the offered list says which providers are already signed in, and where from', async () => {
  const r = await cliAsTyping(await homeWith(PI_STORE), 'q\n', 'login')
  const line = (text: string, id: string): string | undefined =>
    text.split('\n').find(l => l.toLowerCase().includes(id))
  const signedIn = line(r.stdout, 'fireworks')
  expect(signedIn, 'no line for fireworks').toBeDefined()
  expect(signedIn, 'the fireworks line does not say which file its credential is in').toContain(
    '.pi/agent/auth.json'
  )
  const unsigned = line(r.stdout, 'anthropic')
  expect(unsigned, 'anthropic is missing from the offered list').toBeDefined()
  expect(unsigned, 'a provider with no credential is offered as already signed in').not.toContain(
    'signed in'
  )
})

test('a bare `login` takes a provider typed by name and runs its flow', async () => {
  const home = await homeWith()
  const r = await cliAsTyping(home, 'fireworks\ntyped-in-key\n', 'login')
  expect(r.code, `login exited ${r.code}: ${r.stderr}`).toBe(0)
  const written: { fireworks?: unknown } = await Bun.file(
    `${home}/.config/docnamer/credentials.json`
  ).json()
  expect(written.fireworks, 'the picked provider stored no credential').toMatchObject({
    type: 'api_key',
    key: 'typed-in-key'
  })
})

test('a bare `login` refuses a choice that is not in the list, and names it', async () => {
  const r = await cliAsTyping(await homeWith(), 'not-a-provider\n', 'login')
  expect(r.code, 'an unknown choice was accepted').not.toBe(0)
  expect(r.stderr, 'the refusal must name what was typed').toContain('not-a-provider')
})

test('a bare `logout` lists only the credential docnamer itself holds', async () => {
  const r = await cliAsTyping(await homeWith(PI_STORE, OWN_STORE), 'q\n', 'logout')
  expect(r.code, `logout exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, 'logout does not list the credential docnamer holds').toContain('fireworks')
  expect(
    r.stdout,
    "logout offers a credential that is pi's and that docnamer cannot remove"
  ).not.toContain('openai-codex')
})

test('`logout <provider>` refuses a credential that is pi to remove, and says whose', async () => {
  const r = await cliAs(await homeWith(PI_STORE), 'logout', 'fireworks')
  expect(r.code, 'logout reported a success it did not perform').not.toBe(0)
  expect(r.stderr, 'the refusal does not name the file that holds it').toContain(
    '.pi/agent/auth.json'
  )
})

/*
 * The other half of the same branch, and the one that must NOT refuse: when the
 * credential is docnamer's own, `logout <provider>` removes it and says so. The
 * refusal above is written against pi's file, and a refusal that also fired here
 * would leave a person unable to sign out of a key they themselves had stored —
 * the flow would be a one-way door.
 */
test("`logout <provider>` removes docnamer's own credential and says so", async () => {
  const home = await homeWith(undefined, OWN_STORE)
  const r = await cliAs(home, 'logout', 'fireworks')
  expect(r.code, `logout exited ${r.code}: ${r.stderr}`).toBe(0)
  expect(r.stdout, 'logout did not name the provider it signed out of').toContain('fireworks')

  const store = `${home}/.config/docnamer/credentials.json`
  const written: { fireworks?: unknown } = await Bun.file(store).json()
  expect(written.fireworks, 'logout left the credential it reported removing').toBeUndefined()

  const after = await cliAs(home, 'auth')
  expect(after.code, 'auth still found a credential logout had removed').not.toBe(0)
})
