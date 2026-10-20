import builtin from '../docnamer.json' with { type: 'json' }

export type FieldSpec = {
  kind: 'text' | 'date' | 'entity' | 'last4'
  required: boolean
  prompt?: string
  /** An entity on the other side of the document from the person's own
   *  companies (`self`): never one of them. */
  counterparty?: boolean
}

export type DocType = {
  describe: string
  fields: Record<string, FieldSpec>
  template: string
  folder?: string | null
}

export type Config = {
  defaults: {
    date_format: string
    date_order: 'day-first' | 'month-first'
    max_name_length: number
    ocr_text_layer: boolean
    finder_tags: boolean
    finder_comment: boolean
  }
  models: { cheap: string; vision: string; strong: string }
  types: Record<string, DocType>
  entities: Record<string, string[]>
  /** The person's own companies, by canonical entity name. */
  self?: string[]
}

/**
 * The roster the binary was built from, inlined by the bundler so one compiled
 * binary carries its own config to any folder on any machine. A folder carrying
 * its own docnamer.json replaces it; a folder carrying none is planned by this.
 */
export const BUILTIN_CONFIG = builtin as Config

/**
 * The one shipped config name, read from the folder being planned. No other name
 * is ever read: a folder either carries this and is configured by it, or it
 * carries nothing and the built-in roster applies.
 */
export const CONFIG_FILE = 'docnamer.json'

/** Parse a docnamer JSON config; throws when the file is unreadable. */
export function loadConfig(path: string): Config {
  const proc = Bun.spawnSync(['cat', path])
  if (proc.exitCode !== 0) {
    throw new Error(`loadConfig: cannot read config at ${path}: ${proc.stderr.toString().trim()}`)
  }
  return JSON.parse(proc.stdout.toString()) as Config
}
