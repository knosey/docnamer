/**
 * Stage 3 validation and normalisers (R7, R8).
 *
 * validate() takes the model's Analysis and the document Content, normalises
 * every extracted field by its kind (dates to ISO, money to "amount ISO",
 * entities to their canonical name, last4 to four digits) and cross-checks
 * each field's evidence against the document text. Problems become flags on
 * the returned Checked value — never throws, never silently rewrites. A
 * document whose required fields are missing is retargeted to `other`, the
 * roster's fallback of last resort (R7).
 */
import type { Analysis } from "./analyse.ts";
import type { Config } from "./config.ts";
import type { Content } from "./read.ts";

export type Checked = Analysis & { flags: string[] };

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Years outside this band are implausible for scanned paperwork. */
const MIN_YEAR = 1900;

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
};

/**
 * Parse a date string to ISO YYYY-MM-DD. Ambiguous slashed/dotted dates are
 * read by `order` (day-first by default — R8). Returns null on nonsense.
 */
export function parseDate(value: string, order: "day-first" | "month-first"): string | null {
  const v = value.trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(v);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    return order === "day-first" ? iso(y, b, a) : iso(y, a, b);
  }

  m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(v);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return iso(+m[3], month, +m[1]);
  }

  return null;
}

const SYMBOL_CURRENCY: Record<string, string> = {
  "£": "GBP",
  "$": "USD",
  "€": "EUR",
};

/** Normalise a money string to "<amount> <ISO currency>", defaulting to GBP. */
export function normaliseMoney(value: string): string {
  let v = value.trim();
  let currency = "GBP";
  for (const [sym, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (v.includes(sym)) {
      currency = code;
      v = v.replace(sym, "");
      break;
    }
  }
  const codeMatch = /\b(GBP|USD|EUR)\b/i.exec(v);
  if (codeMatch) {
    currency = codeMatch[1].toUpperCase();
    v = v.replace(codeMatch[0], "");
  }
  const amount = v.replace(/,/g, "").replace(/[^\d.]/g, "");
  return `${amount} ${currency}`;
}

const LEGAL_SUFFIX = /\b(ltd|limited|plc|llp|llc|inc|gmbh|uk)\b\.?/gi;

/** Title-case each word of a name. */
const titleCase = (s: string): string =>
  s.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/**
 * Resolve an entity string to its canonical roster name via the alias map;
 * unknown names are tidied (legal suffixes dropped, title-cased).
 */
export function canonicalEntity(value: string, aliases: Record<string, string[]>): string {
  const v = value.trim();
  const lower = v.toLowerCase();
  for (const [canonical, names] of Object.entries(aliases)) {
    if (canonical.toLowerCase() === lower) return canonical;
    for (const alias of names) {
      if (alias.toLowerCase() === lower) return canonical;
    }
  }
  return titleCase(v.replace(LEGAL_SUFFIX, "").replace(/\s{2,}/g, " ").trim());
}

/** Reduce a card/account reference to its last four digits. */
export function reduceLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-4);
}

/** Retarget a checked analysis to `other`, the fallback of last resort (R7). */
export function retargetToOther(checked: Checked): Checked {
  return { ...checked, type: "other", flags: [...checked.flags, "retargeted to other"] };
}

/**
 * Normalise every extracted field by kind, cross-check evidence against the
 * document text, and collect flags. Missing required fields retarget the
 * document to `other`.
 */
export function validate(a: Analysis, content: Content, config: Config): Checked {
  const flags: string[] = [];
  const fields: Analysis["fields"] = {};
  const spec = config.types[a.type];

  if (a.type_confidence < 0.6) {
    flags.push(`unsure of type ${a.type} (confidence ${a.type_confidence})`);
  }

  for (const [name, field] of Object.entries(a.fields)) {
    let value = field.value;
    const kind = spec?.fields[name]?.kind;

    if (value !== null) {
      if (kind === "date") {
        const parsed = parseDate(value, config.defaults.date_order);
        if (parsed === null) {
          flags.push(`field ${name}: unparseable date "${value}"`);
          value = null;
        } else {
          const year = +parsed.slice(0, 4);
          if (year < MIN_YEAR || year > new Date().getFullYear() + 1) {
            flags.push(`field ${name}: implausible date ${parsed}`);
          }
          value = parsed;
        }
      } else if (kind === "money") {
        value = normaliseMoney(value);
      } else if (kind === "entity") {
        value = canonicalEntity(value, config.entities);
      } else if (kind === "last4") {
        value = reduceLast4(value);
      }
    }

    if (field.evidence !== null && !content.text.includes(field.evidence)) {
      flags.push(`field ${name}: evidence not found in document`);
    }

    if (value === null && spec?.fields[name]?.required) {
      flags.push(`missing required field ${name}`);
    }

    fields[name] = { value, evidence: field.evidence };
  }

  let checked: Checked = { ...a, fields, flags };
  if (flags.some((f) => f.startsWith("missing required field"))) {
    checked = retargetToOther(checked);
  }
  return checked;
}
