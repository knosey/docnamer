/**
 * Where docnamer's model credential comes from (D4).
 *
 * Until now the credential was `FIREWORKS_API_KEY` and nothing else. `analyse()`
 * called `completeSimple` from `@earendil-works/pi-ai/compat`, and that module
 * resolves a key from the ENVIRONMENT alone (`dist/compat.js`, `getEnvApiKey`).
 * No login could ever satisfy it, so the variable was load-bearing and the
 * program had no way to be signed in. `compat.d.ts` says as much itself: new
 * code uses `createModels()`.
 *
 * This module owns the collection `analyse()` calls instead — `builtinModels({
 * credentials })`, the catalog of every provider pi-ai knows — and the
 * credential store behind it, in this order:
 *
 *   1. pi's own `~/.pi/agent/auth.json`, when pi holds a login. That file is
 *      already a `Record<providerId, Credential>` — `fireworks` is
 *      `{type:'api_key', key}`, an OAuth provider is
 *      `{type:'oauth', access, refresh, expires, accountId}` — so it satisfies
 *      `CredentialStore.read` as it stands, with no translation. READ ONLY:
 *      pi's file belongs to pi, and docnamer never writes it.
 *   2. `~/.config/docnamer/credentials.json`, docnamer's own store, written by
 *      `docnamer login` and removed by `docnamer logout`.
 *
 * Reads are the composite; WRITES ARE ALWAYS DOCNAMER'S OWN FILE. A refresh of a
 * credential pi holds therefore lands beside pi's file rather than inside it,
 * and `modify`'s `current` is the composite read, so a refresh still sees the
 * credential it is refreshing.
 *
 * Environment variables still answer as a LAST resort, which is pi-ai's own
 * precedence: a stored credential owns the provider, and the environment is
 * consulted only when neither store holds one. That is what keeps CI working
 * without making the variable necessary — which is the whole difference between
 * the old behaviour and this one.
 *
 * Types are derived from the public entrypoints rather than imported by name:
 * `@earendil-works/pi-ai/auth/*` is not in the package's `exports` map, and
 * every one of these names appears in a public signature, so deriving them
 * cannot drift from the shipped version.
 */
import type { CreateModelsOptions, MutableModels } from '@earendil-works/pi-ai/models'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Config } from './config.ts'

/** The credential-store contract `builtinModels` accepts. */
export type CredentialStore = NonNullable<CreateModelsOptions['credentials']>
/** One stored credential: `{type:'api_key', key}` or the OAuth arm. */
export type Credential = NonNullable<Awaited<ReturnType<CredentialStore['read']>>>
/** The non-secret metadata `list()` reports. */
export type CredentialInfo = Awaited<ReturnType<CredentialStore['list']>>[number]
/** What a login flow calls back into: one prompt, and progress notices. */
export type AuthInteraction = Parameters<MutableModels['login']>[2]
/** One question a login flow asks. */
export type AuthPrompt = Parameters<AuthInteraction['prompt']>[0]
/** App-supplied context for `Models.login`. */
export type LoginOptions = NonNullable<Parameters<MutableModels['login']>[3]>

/** `HOME` locates both stores, so its absence is fatal rather than defaulted. */
function home(): string {
  const h = process.env.HOME
  if (h === undefined || h === '') {
    throw new Error('auth: HOME is not set, so neither credential store can be located')
  }
  return h
}

/** pi's credential file. Read, never written. */
export function piAuthPath(): string {
  return `${home()}/.pi/agent/auth.json`
}

/** docnamer's own credential file — the only one this program writes. */
export function ownAuthPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg === undefined || xdg === '' ? `${home()}/.config` : xdg
  return `${base}/docnamer/credentials.json`
}

/** Abbreviate the home directory, because that is how a person names these paths. */
export function tilde(path: string): string {
  const h = home()
  return path.startsWith(h) ? `~${path.slice(h.length)}` : path
}

type StoreFile = Record<string, Credential>

/** A store file that does not exist yet is empty, not an error; one that exists
 *  and does not parse THROWS, because a corrupt credential file that reads as
 *  empty is a login that silently stops working (R2). */
async function readStore(path: string): Promise<StoreFile> {
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  return JSON.parse(await file.text()) as StoreFile
}

/** A secret file is written owner-only: it holds a key that can spend money. */
async function writeStore(path: string, store: StoreFile): Promise<void> {
  await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`)
  const proc = Bun.spawnSync(['chmod', '600', path])
  if (proc.exitCode !== 0) {
    throw new Error(
      `auth: wrote ${path} but could not make it owner-only: ${proc.stderr.toString().trim()}`
    )
  }
}

/** One promise chain per provider id, so `modify` is a serialized
 *  read-modify-write and two logins cannot interleave into one file. */
const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(providerId) ?? Promise.resolve()
  const run = prior.then(fn, fn)
  locks.set(
    providerId,
    run.catch(() => undefined)
  )
  return run
}

/**
 * pi's login first, docnamer's own store second, and every write to the second.
 */
export class DocnamerCredentials implements CredentialStore {
  /** Which FILE answers for a provider — the label `AuthResult.source` cannot
   *  give, because it names the mechanism (`FIREWORKS_API_KEY`) rather than the
   *  store. `docnamer auth` reports this. */
  async origin(providerId: string): Promise<string | null> {
    if (Object.hasOwn(await readStore(piAuthPath()), providerId)) return piAuthPath()
    if (Object.hasOwn(await readStore(ownAuthPath()), providerId)) return ownAuthPath()
    return null
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const pi = await readStore(piAuthPath())
    if (Object.hasOwn(pi, providerId)) return pi[providerId]
    return (await readStore(ownAuthPath()))[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    // pi last, so where both hold a provider the reported type is pi's — the
    // one an actual request would use.
    const seen = new Map<string, CredentialInfo>()
    for (const path of [ownAuthPath(), piAuthPath()]) {
      for (const [providerId, credential] of Object.entries(await readStore(path))) {
        seen.set(providerId, { providerId, type: credential.type })
      }
    }
    return [...seen.values()]
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return withLock(providerId, async () => {
      const next = await fn(await this.read(providerId))
      if (next === undefined) return undefined
      const own = await readStore(ownAuthPath())
      own[providerId] = next
      await writeStore(ownAuthPath(), own)
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await withLock(providerId, async () => {
      const own = await readStore(ownAuthPath())
      if (!Object.hasOwn(own, providerId)) return
      delete own[providerId]
      await writeStore(ownAuthPath(), own)
    })
  }
}

/** The one store every command shares. */
export const credentials = new DocnamerCredentials()

let catalog: MutableModels | null = null

/** The provider catalog, carrying the credential store. Built once: it is a
 *  catalog lookup, not a request, so constructing it costs nothing. */
export function docnamerModels(): MutableModels {
  if (catalog === null) catalog = builtinModels({ credentials })
  return catalog
}

/** The distinct provider ids the configured models live on. */
export function requiredProviders(config: Config): string[] {
  const out: string[] = []
  for (const ref of [config.models.cheap, config.models.vision, config.models.strong]) {
    const provider = ref.slice(0, ref.indexOf('/'))
    if (provider !== '' && !out.includes(provider)) out.push(provider)
  }
  return out
}

/**
 * A line-buffered reader over stdin, for a login flow's prompts. One prompt is
 * answered by one line, and the reader is shared across a flow so a flow that
 * asks twice does not lose the second answer in the first read's buffer.
 */
function lineReader(): () => Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const queued: string[] = []
  return async () => {
    for (;;) {
      const next = queued.shift()
      if (next !== undefined) return next
      const { done, value } = await reader.read()
      if (done) {
        const rest = buffered.trim()
        buffered = ''
        if (rest === '') {
          throw new Error('login: the input ended before the prompt was answered')
        }
        return rest
      }
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() as string
      for (const line of lines) queued.push(line.trim())
    }
  }
}

/**
 * A secret prompt is typed on a terminal that would otherwise echo the key onto
 * the screen. `stty` is the only echo control reachable without a `node:`
 * import, and the whole step is skipped when stdin is not a terminal — a pipe
 * has no echo to suppress, which is also how the tests drive this path.
 */
async function withoutEcho<T>(read: () => Promise<T>): Promise<T> {
  if (process.stdin.isTTY !== true) return read()
  await Bun.spawn(['stty', '-echo'], { stdin: 'inherit' }).exited
  try {
    return await read()
  } finally {
    await Bun.spawn(['stty', 'echo'], { stdin: 'inherit' }).exited
    console.log('')
  }
}

/** One question, printed, with the answer read from stdin. A `select` is
 *  numbered so a person can answer with a digit or with the option's id. */
function prompter(next: () => Promise<string>): (prompt: AuthPrompt) => Promise<string> {
  return async prompt => {
    if (prompt.type === 'select') {
      console.log(prompt.message)
      for (const [i, option] of prompt.options.entries()) {
        const about = option.description === undefined ? '' : ` — ${option.description}`
        console.log(`  ${i + 1}. ${option.label}${about}`)
      }
      const answer = await next()
      const index = Number.parseInt(answer, 10)
      if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) {
        return prompt.options[index - 1].id
      }
      const chosen = prompt.options.find(o => o.id === answer)
      if (chosen === undefined) {
        throw new Error(`login: "${answer}" is not one of the offered options`)
      }
      return chosen.id
    }
    console.log(prompt.message)
    if (prompt.placeholder !== undefined) console.log(`  (${prompt.placeholder})`)
    return prompt.type === 'secret' ? withoutEcho(next) : next()
  }
}

/**
 * Sign in to one provider and store what comes back. The flow itself belongs to
 * the provider — an API key prompt for most, a browser or device flow for an
 * OAuth provider — and the credential is persisted through `modify`, which is
 * `CredentialStore`'s only write path.
 *
 * `type` is the provider's own preference: an OAuth arm is used when the
 * provider has one and `'oauth'` is asked for, otherwise the api-key arm.
 */
export async function login(
  providerId: string,
  options: { type?: 'api_key' | 'oauth' } & LoginOptions
): Promise<Credential> {
  const models = docnamerModels()
  const provider = models.getProvider(providerId)
  if (provider === undefined) {
    throw new Error(`login: no provider "${providerId}" in the pi-ai catalog`)
  }
  const wanted = options.type
  const type =
    wanted !== undefined ? wanted : provider.auth.oauth !== undefined ? 'oauth' : 'api_key'
  const auth = type === 'oauth' ? provider.auth.oauth : provider.auth.apiKey
  if (auth === undefined) {
    throw new Error(`login: provider "${providerId}" has no ${type} login`)
  }
  if (type === 'api_key' && auth.login === undefined) {
    throw new Error(
      `login: provider "${providerId}" reads its key from the environment only, so there is nothing to store — set the variable its docs name instead`
    )
  }
  const next = lineReader()
  const interaction: AuthInteraction = {
    prompt: prompter(next),
    notify: event => {
      if (event.type === 'auth_url') {
        console.log(`open: ${event.url}`)
        if (event.instructions !== undefined) console.log(event.instructions)
      } else if (event.type === 'device_code') {
        console.log(`open: ${event.verificationUri}`)
        console.log(`code: ${event.userCode}`)
      } else {
        console.log(event.message)
      }
    }
  }
  const credential = await models.login(providerId, type, interaction, {
    agentName: 'docnamer',
    ...(options.getDeviceId === undefined ? {} : { getDeviceId: options.getDeviceId })
  })
  return credential
}

/** Remove docnamer's own credential for a provider. A credential pi holds is
 *  pi's to remove, and `docnamer logout` says so rather than pretending. */
export async function logout(providerId: string): Promise<void> {
  await credentials.delete(providerId)
  await docnamerModels().logout(providerId)
}
