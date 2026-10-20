/**
 * Stage 2 classify-and-extract model call (R3, R6).
 *
 * analyse() classifies the document into one of the configured types and
 * extracts that type's fields, each with its verbatim evidence. The contract is
 * declared as a TOOL rather than as prose in the prompt: the reply then arrives
 * as already-parsed arguments instead of text to be scraped, which a chatty or
 * fenced answer defeats.
 *
 * The contract is a DISCRIMINATED UNION, one branch per type: each branch pins
 * its own type with a single-value enum and names exactly that type's fields, so
 * there is no free-form object anywhere in it. A flat schema cannot express this
 * — which fields apply depends on which type is chosen, so a flat `fields` is
 * free-form and the model invents its own names (measured: 0 of 8 runs used the
 * declared names, and validate() then normalised nothing, because it looks every
 * name up in the roster).
 *
 * Neither configured model advertises `compat.supportsStrictMode`, so the
 * provider does NOT enforce the schema and `strict: 'prefer'` degrades to plain
 * function calling. `asAnalysis` is therefore the enforcement: a reply that names
 * a field its type does not declare, or omits a required one, is rejected, and
 * the repair turn quotes that rejection back at the model.
 *
 * Text handed to the model is capped at 4000 characters (R4); page images, when
 * Stage 1 produced them, go along in the same call. A call that cannot complete
 * — unknown model, no credential, two unusable replies — is a `Failed`, never a
 * throw and never a fabricated Analysis (R6).
 */
import { getModel, getProviders } from '@earendil-works/pi-ai/compat'
import type { AssistantMessage, Message, Tool, ToolCall } from '@earendil-works/pi-ai/compat'
import { docnamerModels } from './auth.ts'
import type { Config, DocType } from './config.ts'
import type { Content } from './read.ts'

export type Analysis = {
  type: string
  type_confidence: number
  fields: Record<string, { value: string | null; evidence: string | null }>
  summary: string
}

export type Failed = { failed: true; reason: string; raw: string }

export function isFailed(r: Analysis | Failed): r is Failed {
  return (r as Failed).failed === true
}

/** Text handed to a model is capped at 4000 characters (R4). */
const TEXT_CAP = 4000

/** The tool the model calls to submit its classification. */
const TOOL_NAME = 'submit_analysis'

/** How many model calls one document may cost: the ask and one repair. */
const ATTEMPTS = [0, 1] as const

/** The JSON-schema shape of an analysis, as pi-ai's tool layer wants it. */
export type AnalysisSchema = Tool['parameters']

/**
 * The contract: a flat object that NAMES EVERY FIELD the roster declares.
 *
 * `fields` carries one declared property per field name used by any type, and
 * `additionalProperties: false`, so no name outside the roster is expressible —
 * the model cannot invent `invoice_number`, because the schema has no such
 * property and forbids undeclared ones. Which of those names a given document
 * must supply depends on its type, so `required` is left off the schema and
 * enforced in `asAnalysis` against the chosen type.
 *
 * A superset works because no two types declare the same field name with
 * different kinds (checked against the shipped roster: 15 types, 18 names,
 * `date` is always a date, `number` is always text, `last4` is always a
 * last4). Should a type ever reuse a name for a different kind, this is the
 * line to revisit.
 *
 * A discriminated union (`oneOf`, one branch per type) was tried and MEASURED
 * BROKEN with the configured provider: the model returned empty arguments
 * (`{}`) on 8 of 8 runs, the schema having grown past what it would read.
 *
 * `kind` is deliberately absent: it selects a normaliser in Stage 3 and is none
 * of the model's business. The model's job is to copy the value as the document
 * states it.
 */
export function buildSchema(types: Record<string, DocType>): AnalysisSchema {
  const properties: Record<string, unknown> = {}
  for (const t of Object.values(types)) {
    for (const field of Object.keys(t.fields)) {
      if (Object.hasOwn(properties, field)) continue
      properties[field] = {
        type: 'object',
        required: ['value', 'evidence'],
        properties: {
          value: {
            type: ['string', 'null'],
            description: 'The value exactly as the document states it, or null when absent.'
          },
          evidence: {
            type: ['string', 'null'],
            description: 'The verbatim line the value came from, or null.'
          }
        },
        additionalProperties: false
      }
    }
  }
  return {
    type: 'object',
    required: ['type', 'type_confidence', 'fields', 'summary'],
    properties: {
      type: {
        type: 'string',
        enum: Object.keys(types),
        description: Object.entries(types)
          .map(([name, t]) => `${name}: ${t.describe}`)
          .join(' ')
      },
      type_confidence: { type: 'number', minimum: 0, maximum: 1 },
      fields: {
        type: 'object',
        description:
          'One entry per field the chosen type declares, named exactly as the type declares it.',
        properties,
        additionalProperties: false
      },
      summary: { type: 'string', description: 'At most 20 words.' }
    },
    additionalProperties: false
  } as AnalysisSchema
}

/** The field names of each type, as one line of the prompt. */
function rosterLine(types: Record<string, DocType>): string {
  return Object.entries(types)
    .map(([name, t]) => `${name}: ${Object.keys(t.fields).join(', ')}`)
    .join('; ')
}

export type ModelRef = ReturnType<typeof getModel>

/** Resolve "provider/id" or a bare id against the pi-ai builtin catalog. */
export function resolveModel(ref: string): NonNullable<ModelRef> | null {
  const slash = ref.indexOf('/')
  if (slash >= 0) {
    const m = getModel(ref.slice(0, slash) as never, ref.slice(slash + 1) as never)
    if (m) return m as NonNullable<ModelRef>
  } else {
    for (const provider of getProviders()) {
      const m = getModel(provider as never, ref as never)
      if (m) return m as NonNullable<ModelRef>
    }
  }
  return null
}

/**
 * The contract as a tool. `strict: 'prefer'` buys provider-side constrained
 * sampling where the model advertises it and degrades to an ordinary tool call
 * where it does not — measured on the two configured models, both of which
 * report `compat.supportsStrictMode` absent, where `strict: 'require'` throws
 * ("requires JSON-schema constrained sampling, but strict tools are unsupported")
 * and `'prefer'` resolves to plain function calling. `'prefer'` is what keeps
 * both configured models usable.
 */
function analysisTool(types: Record<string, DocType>): Tool {
  return {
    name: TOOL_NAME,
    description:
      'Submit the classification of this document and the extracted fields of the chosen type.',
    parameters: buildSchema(types),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' }
  }
}

function buildPrompt(content: Content, fileName: string, config: Config): string {
  const entities = JSON.stringify(config.entities)
  const dateOrder =
    config.defaults.date_order === 'day-first'
      ? 'Ambiguous slashed dates are day-first (03/04/2026 is 3 April 2026).'
      : 'Ambiguous slashed dates are month-first (03/04/2026 is March 4, 2026).'
  return [
    `Classify the document "${fileName}" into exactly one of the configured types and extract that type's fields.`,
    `Call ${TOOL_NAME}. Its schema has one branch per type; pick the branch whose enum matches the type, and name the fields exactly as that branch names them. The configured types and their fields: ${rosterLine(config.types)}`,
    `Known entities and their aliases: ${entities}`,
    `Dates use the format ${config.defaults.date_format}. ${dateOrder}`,
    'Every field value must come with its verbatim evidence line from the document; use null when absent.',
    `The summary is at most 20 words.`,
    '',
    'Document text:',
    content.text.slice(0, TEXT_CAP)
  ].join('\n')
}

/**
 * Read the submitted analysis out of a reply, or say what was wrong with it.
 *
 * A missing call, arguments the provider could not parse (which pi reports as
 * `argumentsError`, carrying the text the model actually sent), and arguments
 * that do not match the contract are three different errors and are named as
 * such, because the repair turn quotes whichever one applies.
 */
function readCall(
  msg: AssistantMessage,
  types: Record<string, DocType>
): { analysis: Analysis } | { error: string; raw: string } {
  const text = msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  const call = msg.content.find((b): b is ToolCall => b.type === 'toolCall' && b.name === TOOL_NAME)
  if (!call) {
    return { error: `the reply contained no ${TOOL_NAME} tool call`, raw: text }
  }
  if (call.argumentsError) {
    return { error: call.argumentsError, raw: call.argumentsError }
  }
  const analysis = asAnalysis(call.arguments, types)
  if (typeof analysis === 'string') {
    const raw = JSON.stringify(call.arguments)
    return { error: analysis, raw }
  }
  return { analysis }
}

/**
 * Check submitted arguments against the contract. Returns the reason it was
 * refused rather than throwing: the caller turns an unusable reply into a repair
 * turn and, if that also fails, into a `Failed` (R6, and spec Stage 2's "if
 * still invalid"). The reason names the offending fields, because the repair
 * turn quotes it verbatim.
 *
 * The field-name check is the one that matters. The provider does not enforce
 * the schema, so this is what stops an invented `invoice_number` from reaching
 * validate(), where it would be looked up in the roster, found nowhere, and
 * silently dropped — leaving every template slot empty.
 */
function asAnalysis(
  args: Record<string, unknown>,
  types: Record<string, DocType>
): Analysis | string {
  const type = args.type
  const confidence = args.type_confidence
  const summary = args.summary
  const rawFields = args.fields
  if (typeof type !== 'string') return 'the type argument is missing or not a string'
  const t = Object.hasOwn(types, type) ? types[type] : undefined
  if (t === undefined) {
    return `the type "${type}" is not one of the configured types (${Object.keys(types).join(', ')})`
  }
  if (typeof confidence !== 'number')
    return 'the type_confidence argument is missing or not a number'
  if (typeof summary !== 'string') return 'the summary argument is missing or not a string'
  if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) {
    return 'the fields argument is missing or not an object'
  }

  const declared = Object.keys(t.fields)
  const got = Object.keys(rawFields)
  const unknown = got.filter(name => !declared.includes(name))
  if (unknown.length > 0) {
    return `the fields object named ${unknown.join(', ')}, which type "${type}" does not declare; "${type}" declares exactly ${declared.join(', ')}`
  }
  const missing = declared.filter(name => t.fields[name].required && !got.includes(name))
  if (missing.length > 0) {
    return `the fields object omitted ${missing.join(', ')}, which type "${type}" requires; a required field that the document does not state takes a null value, it is not left out`
  }

  const fields: Analysis['fields'] = {}
  for (const [name, entry] of Object.entries(rawFields)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `the field "${name}" is not an object with a value and an evidence`
    }
    const value = (entry as Record<string, unknown>).value
    const evidence = (entry as Record<string, unknown>).evidence
    if (typeof value !== 'string' && value !== null) {
      return `the field "${name}" has a value that is neither a string nor null`
    }
    if (typeof evidence !== 'string' && evidence !== null) {
      return `the field "${name}" has an evidence that is neither a string nor null`
    }
    fields[name] = { value, evidence }
  }
  return { type, type_confidence: confidence, fields, summary }
}

/** Page images ride along in the same call as the text (spec Stage 2). */
async function imageBlocks(images: string[]): Promise<unknown[]> {
  const blocks: unknown[] = []
  for (const img of images) {
    const bytes = new Uint8Array(await Bun.file(img).arrayBuffer())
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    blocks.push({ type: 'image', data: btoa(bin), mimeType: 'image/png' })
  }
  return blocks
}

export async function analyse(
  content: Content,
  fileName: string,
  config: Config,
  seat?: 'cheap' | 'vision' | 'strong'
): Promise<Analysis | Failed> {
  // A call carrying page images goes to the vision model; text-only stays cheap,
  // and the caller names a seat when it wants a specific one (spec Stage 2).
  // SAFE: `seat` is optional by signature — undefined means "choose for me", which
  // is the documented default, not a missing value.
  const key = seat ?? (content.images.length > 0 ? 'vision' : 'cheap')
  const ref = config.models[key]
  const model = resolveModel(ref)
  if (!model) {
    return {
      failed: true,
      reason: `analyse: unknown model "${ref}" in config.models.${key}`,
      raw: ''
    }
  }

  const blocks: unknown[] = [
    { type: 'text', text: buildPrompt(content, fileName, config) },
    ...(await imageBlocks(content.images))
  ]
  const messages: Message[] = [{ role: 'user', content: blocks as never, timestamp: Date.now() }]

  // The schema depends only on the roster: build the tool once, not per attempt.
  const tools = [analysisTool(config.types)]
  let raw = ''
  let error = ''
  for (const attempt of ATTEMPTS) {
    let msg: AssistantMessage
    try {
      msg = await docnamerModels().completeSimple(model as never, { messages, tools } as never, {
        temperature: 0
      })
    } catch (e) {
      return {
        failed: true,
        reason: `analyse: model call to ${ref} failed: ${(e as Error).message}`,
        raw
      }
    }

    const result = readCall(msg, config.types)
    if ('analysis' in result) return result.analysis
    raw = result.raw
    error = result.error

    // One repair turn, carrying the model's own reply and the error it must fix
    // (spec Stage 2). The last attempt leaves `error` naming why we gave up.
    if (attempt < ATTEMPTS.length - 1) {
      messages.push(msg, {
        role: 'user',
        content: `Fix this error: ${error}\nCall ${TOOL_NAME} again with corrected arguments.`,
        timestamp: Date.now()
      })
    }
  }

  return { failed: true, reason: `analyse: ${ref} returned no valid analysis: ${error}`, raw }
}
