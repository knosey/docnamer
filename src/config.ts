import builtin from '../docnamer.json' with { type: 'json' }

export type FieldSpec = {
  kind: 'text' | 'date' | 'entity' | 'last4'
  required: boolean
  prompt?: string
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
}

/**
 * The roster the binary was built from, inlined by the bundler so one compiled
 * binary carries its own config to any folder on any machine. A folder that
 * carries its own docnamer.json replaces it; a folder that carries none is
 * planned by this, which is the same file — there is no thinner config for the
 * no-file case, and nothing to install beside the binary.
 */
export const BUILTIN_CONFIG = builtin as Config

/**
 * The one shipped config name, read from the folder being planned. One file,
 * one location: a folder either carries this and is configured by it, or it
 * carries nothing and the built-in roster applies. No other name is ever read.
 */
export const CONFIG_FILE = 'docnamer.json'

/** Parse the docnamer JSON config; throws when the file is unreadable. */
export function loadConfig(path: string): Config {
  const proc = Bun.spawnSync(['cat', path])
  if (proc.exitCode !== 0) {
    throw new Error(`loadConfig: cannot read config at ${path}: ${proc.stderr.toString().trim()}`)
  }
  return JSON.parse(proc.stdout.toString()) as Config
}
