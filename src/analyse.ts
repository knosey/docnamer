/**
 * Stage 2 classify-and-extract model call (R3, R6).
 *
 * analyse() makes ONE model call (the configured cheap model) that classifies
 * the document into one of the configured types and extracts that type's
 * fields, each with its verbatim evidence. Text handed to the model is capped
 * at 4000 characters (R4); page images, when Stage 1 produced them, go along
 * in the same call. A call that cannot complete — unknown model, no
 * credential, unparseable reply — is a `Failed`, never a throw and never a
 * fabricated Analysis (R6).
 */
import { getModel, getProviders, completeSimple } from "@earendil-works/pi-ai/compat";
import type { Config, DocType } from "./config.ts";
import type { Content } from "./read.ts";

export type Analysis = {
  type: string;
  type_confidence: number;
  fields: Record<string, { value: string | null; evidence: string | null }>;
  summary: string;
};

export type Failed = { failed: true; reason: string; raw: string };

export function isFailed(r: Analysis | Failed): r is Failed {
  return (r as Failed).failed === true;
}

/** Text handed to a model is capped at 4000 characters (R4). */
const TEXT_CAP = 4000;

/** JSON-schema-ish description of the roster, fed to the model as the contract. */
export function buildSchema(types: Record<string, DocType>): unknown {
  const roster: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(types)) {
    const fields: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(t.fields)) {
      fields[field] = { kind: spec.kind, required: spec.required };
    }
    roster[name] = { describe: t.describe, fields };
  }
  return {
    type: "object",
    required: ["type", "type_confidence", "fields", "summary"],
    properties: {
      type: { type: "string", enum: Object.keys(types) },
      type_confidence: { type: "number", minimum: 0, maximum: 1 },
      fields: {
        type: "object",
        description: "One entry per field of the chosen type: its value and the verbatim evidence line, or nulls.",
      },
      summary: { type: "string", description: "At most 20 words." },
    },
    roster,
  };
}

type ModelRef = ReturnType<typeof getModel>;

/** Resolve "provider/id" or a bare id against the pi-ai builtin catalog. */
function resolveModel(ref: string): NonNullable<ModelRef> | null {
  const slash = ref.indexOf("/");
  if (slash >= 0) {
    const m = getModel(ref.slice(0, slash) as never, ref.slice(slash + 1) as never);
    if (m) return m as NonNullable<ModelRef>;
  } else {
    for (const provider of getProviders()) {
      const m = getModel(provider as never, ref as never);
      if (m) return m as NonNullable<ModelRef>;
    }
  }
  return null;
}

function buildPrompt(content: Content, fileName: string, config: Config): string {
  const schema = JSON.stringify(buildSchema(config.types));
  const entities = JSON.stringify(config.entities);
  const dateOrder =
    config.defaults.date_order === "day-first"
      ? "Ambiguous slashed dates are day-first (03/04/2026 is 3 April 2026)."
      : "Ambiguous slashed dates are month-first (03/04/2026 is March 4, 2026).";
  return [
    `Classify the document "${fileName}" into exactly one of the configured types and extract that type's fields.`,
    `Reply with a single JSON object matching this contract (no prose, no code fence): ${schema}`,
    `Known entities and their aliases: ${entities}`,
    `Dates use the format ${config.defaults.date_format}. ${dateOrder}`,
    "Every field value must come with its verbatim evidence line from the document; use null when absent.",
    `The summary is at most 20 words.`,
    "",
    "Document text:",
    content.text.slice(0, TEXT_CAP),
  ].join("\n");
}

function parseAnalysis(raw: string): Analysis | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Analysis;
    if (typeof parsed.type !== "string" || typeof parsed.type_confidence !== "number") return null;
    if (typeof parsed.fields !== "object" || parsed.fields === null) return null;
    if (typeof parsed.summary !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function analyse(
  content: Content,
  fileName: string,
  config: Config,
): Promise<Analysis | Failed> {
  const ref = config.models.cheap;
  const model = resolveModel(ref);
  if (!model) {
    return { failed: true, reason: `analyse: unknown model "${ref}" in config.models.cheap`, raw: "" };
  }

  const blocks: unknown[] = [{ type: "text", text: buildPrompt(content, fileName, config) }];
  for (const img of content.images) {
    const bytes = new Uint8Array(await Bun.file(img).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    blocks.push({ type: "image", data: btoa(bin), mimeType: "image/png" });
  }

  let raw: string;
  try {
    const msg = await completeSimple(
      model as never,
      { messages: [{ role: "user", content: blocks }] } as never,
    );
    raw = ((msg as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  } catch (e) {
    return { failed: true, reason: `analyse: model call to ${ref} failed: ${(e as Error).message}`, raw: "" };
  }

  const parsed = parseAnalysis(raw);
  if (!parsed) {
    return { failed: true, reason: `analyse: ${ref} returned no parseable JSON analysis`, raw };
  }
  return parsed;
}
