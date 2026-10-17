export type FieldSpec = {
  kind: 'text' | 'date' | 'entity' | 'last4'
  required: boolean
  prompt?: string
}

export type DocType = {
  describe: string
  fields: Record<string, FieldSpec>
  template: string
  tag?: string
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

/** Parse the docnamer YAML config; throws when the file is unreadable. */
export function loadConfig(path: string): Config {
  const proc = Bun.spawnSync(['cat', path])
  if (proc.exitCode !== 0) {
    throw new Error(`loadConfig: cannot read config at ${path}: ${proc.stderr.toString().trim()}`)
  }
  return Bun.YAML.parse(proc.stdout.toString()) as Config
}
