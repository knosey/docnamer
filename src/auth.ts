/**
 * Where docnamer's model credential comes from: pi's own
 * `~/.pi/agent/auth.json` first, then `~/.config/docnamer/credentials.json`,
 * then the environment as pi-ai's own last resort — a stored credential owns the
 * provider and the environment answers only when neither store holds one, which
 * is what keeps CI working without making the variable necessary.
 *
 * pi's file is READ ONLY: it belongs to pi. A refresh of a credential pi holds
 * therefore lands in docnamer's own store, beside pi's file rather than inside
 * it, and `modify`'s `current` is the composite read, so a refresh still sees
 * the credential it is refreshing.
 *
 * The types below are derived from the public entrypoints rather than imported
 * by name: `@earendil-works/pi-ai/auth/*` is not in the package's `exports`
 * map, and every one of these names appears in a public signature, so deriving
 * them cannot drift from the shipped version.
 */
import type { CreateModelsOptions, MutableModels } from '@earendil-works/pi-ai/models'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Config } from './config.ts'
import { stdinLine } from './prompt.ts'
import type { Ui } from './ui.ts'

/** The credential-store contract `builtinModels` accepts. */
export type CredentialStore = NonNullable<CreateModelsOptions['credentials']>
/** One stored credential: `{type:'api_key', key}` or the OAuth arm. */
export type Credential = NonNullable<Awaited<ReturnType<CredentialStore['read']>>>
/** The non-secret metadata `list()` reports. */
type CredentialInfo = Awaited<ReturnType<CredentialStore['list']>>[number]
/** What a login flow calls back into: one prompt, and progress notices. */
type AuthInteraction = Parameters<MutableModels['login']>[2]
/** One question a login flow asks. */
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0]
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
function piAuthPath(): string {
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
 *  empty is a login that silently stops working. */
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
    // The lock tail swallows the failure so the NEXT caller chains onto a settled
    // promise; this caller still sees it through the `run` returned below.
    run.catch(() => undefined)
  )
  return run
}

/**
 * pi's login first, docnamer's own store second, and every write to the second.
 */
class DocnamerCredentials implements CredentialStore {
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

/** Only what docnamer's OWN store holds. `logout` can remove nothing else, so
 *  the list it offers a person must not contain a credential that is pi's —
 *  offering one would be a choice the command cannot carry out. */
export async function ownCredentials(): Promise<{ providerId: string; type: string }[]> {
  const own = await readStore(ownAuthPath())
  return Object.entries(own).map(([providerId, credential]) => ({
    providerId,
    type: credential.type
  }))
}

/**
 * A secret prompt is typed on a terminal that would otherwise echo the key onto
 * the screen. `stty` is the only echo control reachable without a `node:`
 * import, and the whole step is skipped when stdin is not a terminal — a pipe
 * has no echo to suppress, which is also how the tests drive this path.
 */
async function withoutEcho<T>(read: () => Promise<T>, u: Ui): Promise<T> {
  if (process.stdin.isTTY !== true) return read()
  await Bun.spawn(['stty', '-echo'], { stdin: 'inherit' }).exited
  try {
    return await read()
  } finally {
    await Bun.spawn(['stty', 'echo'], { stdin: 'inherit' }).exited
    u.log('')
  }
}

/** One question, printed, with the answer read from stdin. A `select` is
 *  numbered so a person can answer with a digit or with the option's id. */
function prompter(next: () => Promise<string>, u: Ui): (prompt: AuthPrompt) => Promise<string> {
  return async prompt => {
    if (prompt.type === 'select') {
      u.log(`? ${u.bold(prompt.message)}`)
      const width = prompt.options.reduce((w, o) => Math.max(w, o.label.length), 0)
      for (const [i, option] of prompt.options.entries()) {
        const about = option.description === undefined ? '' : u.dim(option.description)
        u.log(u.row(`  ${i + 1}) `, [option.label, about], [width, 0]))
      }
      const answer = (await next()).trim()
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
    u.log(`? ${u.bold(prompt.message)}`)
    if (prompt.placeholder !== undefined) u.log(u.note(prompt.placeholder))
    return prompt.type === 'secret' ? withoutEcho(next, u) : next()
  }
}

/**
 * Sign in to one provider and store what comes back. The flow belongs to the
 * provider — an API key prompt for most, a browser or device flow for an OAuth
 * provider — and the credential is persisted through `modify`, the store's only
 * write path. `type` is the provider's own preference: the OAuth arm when it has
 * one and `'oauth'` was asked for, otherwise the api-key arm.
 */
export async function login(
  providerId: string,
  u: Ui,
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
  const next = stdinLine
  const interaction: AuthInteraction = {
    prompt: prompter(next, u),
    notify: event => {
      if (event.type === 'auth_url') {
        u.log(`open: ${event.url}`)
        if (event.instructions !== undefined) u.log(u.note(event.instructions))
      } else if (event.type === 'device_code') {
        u.log(`open: ${event.verificationUri}`)
        u.log(`code: ${event.userCode}`)
      } else {
        u.log(event.message)
      }
    }
  }
  const credential = await models.login(providerId, type, interaction, {
    agentName: 'docnamer',
    ...(options.getDeviceId === undefined ? {} : { getDeviceId: options.getDeviceId })
  })
  return credential
}

/**
 * Remove docnamer's own credential for a provider.
 *
 * A credential pi holds is pi's to remove, and this says so rather than
 * reporting a success it did not perform: `delete` only ever touches docnamer's
 * file, so a logout that reached here with pi's credential in hand would print
 * "signed out" and change nothing. The refusal names the file that holds it.
 */
export async function logout(providerId: string): Promise<void> {
  const origin = await credentials.origin(providerId)
  if (origin === piAuthPath()) {
    throw new Error(
      `logout: docnamer did not store the credential for "${providerId}" — it is pi's, in ${tilde(piAuthPath())}, and \`pi\` is what removes it`
    )
  }
  if (origin === null) {
    throw new Error(
      `logout: docnamer holds no credential for "${providerId}", so there is nothing to remove`
    )
  }
  await credentials.delete(providerId)
  await docnamerModels().logout(providerId)
}
