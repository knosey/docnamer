/**
 * Shared e2e harness for the doc-renamer-pipeline feature.
 *
 * One exported function per node of INTERACTIONS.md's digraphs. A flow test is
 * its digraph's steps called in order plus the assertion of its Outcome:
 *
 *   const s = new Session();
 *   await entry(s); await read(s); await analyse(s); await name(s); await outcome(s);
 *
 * Each run is self-contained: a fresh temp folder, seeded fixture documents, and
 * the `docnamer` CLI resolved per run. Nothing is written into the repo.
 *
 * The only integration surface is the CLI subprocess (decision D3): the steps
 * drive `docnamer plan <folder>` and observe `.docnamer-plan.json` and the
 * originals on disk. A step whose claim is not observable from that surface
 * throws `Skipped` — a machine-readable, non-green hole — rather than passing.
 *
 * Native Bun APIs only; no `node:` built-ins (D2).
 */

export type PlanRow = {
  old: string;
  new: string;
  type: string;
  fields: Record<string, string>;
  evidence: Record<string, string>;
  flags: string[];
  summary: string;
  size: number;
  mtime: number;
  status: "pending" | "accepted" | "skipped";
};

/** A named hole: the claim cannot be closed on the current observation surface. */
export class Skipped extends Error {
  readonly skip = true;
  constructor(readonly claim: string) {
    super("SKIP: " + claim);
    this.name = "Skipped";
  }
}

const repo = import.meta.dir.replace(/\/tests$/, "");

function base(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/** Fixture documents seeded into every run's temp folder. */
const SEED: Array<{ name: string; body: string }> = [
  {
    name: "invoice-acme-2026-04.txt",
    body: [
      "INVOICE",
      "Acme Ltd",
      "Invoice number: INV-0042",
      "Date: 03/04/2026",
      "Total: 482.50 GBP",
      "",
    ].join("\n"),
  },
  {
    name: "letter-hmrc.txt",
    body: ["Dear Sir,", "A letter from HMRC dated 12 March 2026.", ""].join("\n"),
  },
];

export class Session {
  /** Per-run working folder. */
  dir = "";
  /** `<dir>/.docnamer-plan.json`. */
  planPath = "";
  /** Parsed plan rows. */
  plan: PlanRow[] = [];
  /** Resolved CLI argv, or null when no `docnamer` is reachable. */
  cli: string[] | null = null;
  /** Last CLI invocation. */
  last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: "", stderr: "" };
  /** Seeded files' size and mtime, captured before `plan` runs. */
  originals = new Map<string, { size: number; mtime: number }>();
  booted = false;
}

async function shell(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

async function resolveCli(): Promise<string[] | null> {
  const override = Bun.env.DOCNAMER_BIN;
  if (override && override.trim()) return override.trim().split(/\s+/);
  const onPath = Bun.which("docnamer");
  if (onPath) return [onPath];
  const src = `${repo}/src/cli.ts`;
  if (await Bun.file(src).exists()) return [Bun.which("bun") ?? "bun", src];
  return null;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("*").scan({ cwd: dir, onlyFiles: true })) out.push(rel);
  return out;
}

/** Boot the isolated environment: temp folder, seeded fixtures, resolved CLI. */
async function boot(s: Session): Promise<void> {
  if (s.booted) return;
  const dir = `${Bun.env.TMPDIR ?? Bun.env.TMP ?? "/tmp"}/docnamer-${crypto.randomUUID()}`;
  Bun.spawnSync(["mkdir", "-p", dir]);
  s.dir = dir;
  s.planPath = `${dir}/.docnamer-plan.json`;
  for (const f of SEED) await Bun.write(`${dir}/${f.name}`, f.body);

  // A real fixture set, when one exists, is copied in beside the seed files.
  const fixtures = `${repo}/tests/fixtures`;
  if (await Bun.file(fixtures).exists()) {
    for await (const rel of new Bun.Glob("**/*").scan({ cwd: fixtures, onlyFiles: true })) {
      const bytes = await Bun.file(`${fixtures}/${rel}`).arrayBuffer();
      await Bun.write(`${dir}/${base(rel)}`, bytes);
    }
  }

  for (const name of await listFiles(dir)) {
    const f = Bun.file(`${dir}/${name}`);
    s.originals.set(name, { size: f.size, mtime: f.lastModified });
  }
  s.cli = await resolveCli();
  s.booted = true;
}

/** Run `docnamer plan <folder>` and parse the plan file. */
async function runPlan(s: Session): Promise<void> {
  if (!s.cli) {
    throw new Skipped(
      "docnamer CLI absent: set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts",
    );
  }
  const res = await shell([...s.cli, "plan", s.dir]);
  s.last = res;
  if (res.code !== 0) {
    throw new Error(`docnamer plan exited ${res.code}\n${res.stderr}${res.stdout}`);
  }
  const parsed = JSON.parse(await Bun.file(s.planPath).text());
  s.plan = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.files ?? []);
}

/** Boot and plan if a prior step has not already done so. */
async function ensure(s: Session): Promise<void> {
  if (!s.booted) await boot(s);
  if (!s.cli) {
    throw new Skipped(
      "docnamer CLI absent: set DOCNAMER_BIN, install `docnamer`, or add src/cli.ts",
    );
  }
  if (s.last.code !== 0) await runPlan(s);
}

// --- I1: Plan a folder of documents without touching files --------------------

/** entry: boot the environment and run `docnamer plan <folder>`. */
export async function entry(s: Session): Promise<Session> {
  await boot(s);
  await runPlan(s);
  return s;
}

/** read: Stage 1 — every seeded file reached the plan as a row. */
export async function read(s: Session): Promise<Session> {
  await ensure(s);
  const seeded = [...s.originals.keys()];
  const planned = new Set(s.plan.map((r) => base(r.old)));
  const missing = seeded.filter((n) => !planned.has(n));
  if (missing.length) throw new Error(`Stage 1 read missed files: ${missing.join(", ")}`);
  return s;
}

/** analyse: Stages 2-3 — each row carries a type and a summary. */
export async function analyse(s: Session): Promise<Session> {
  await ensure(s);
  for (const r of s.plan) {
    if (!r.type) throw new Error(`Stage 2 analyse produced no type for ${r.old}`);
    if (!r.summary) throw new Error(`Stage 2 analyse produced no summary for ${r.old}`);
  }
  return s;
}

/** name: Stage 4 — each row proposes a non-empty, filesystem-safe name. */
export async function name(s: Session): Promise<Session> {
  await ensure(s);
  for (const r of s.plan) {
    if (!r.new) throw new Error(`Stage 4 produced no name for ${r.old}`);
    if (/[/\\:*?"<>|]/.test(r.new)) throw new Error(`Stage 4 name not sanitised: ${r.new}`);
  }
  return s;
}

/** outcome: plan written with pending rows; originals unchanged. */
export async function outcome(s: Session): Promise<Session> {
  await ensure(s);
  if (!(await Bun.file(s.planPath).exists())) {
    throw new Error("outcome: .docnamer-plan.json not written");
  }
  for (const r of s.plan) {
    if (r.status !== "pending") {
      throw new Error(`outcome: row ${r.old} status ${r.status} != pending`);
    }
  }
  for (const [n, before] of s.originals) {
    const f = Bun.file(`${s.dir}/${n}`);
    if (f.size !== before.size || f.lastModified !== before.mtime) {
      throw new Error(`outcome: original ${n} was modified`);
    }
  }
  return s;
}

// --- I2: Vision fallback only when OCR is weak --------------------------------

/** text: a text-layer document is planned from its text layer. */
export async function text(s: Session): Promise<Session> {
  await ensure(s);
  const textFiles = [...s.originals.keys()].filter((n) => /\.(txt|md)$/i.test(n));
  if (!textFiles.length) throw new Skipped("I2 text: no text-layer fixture seeded");
  const planned = new Set(s.plan.map((r) => base(r.old)));
  const missing = textFiles.filter((n) => !planned.has(n));
  if (missing.length) {
    throw new Error(`I2 text: text-layer files not planned: ${missing.join(", ")}`);
  }
  return s;
}

/** ocr: a scanned document is read by OCR. */
export async function ocr(s: Session): Promise<Session> {
  await ensure(s);
  const scanned = [...s.originals.keys()].filter((n) => /scann/i.test(n));
  if (!scanned.length) throw new Skipped("I2 ocr: no scanned fixture seeded (tests/fixtures/ absent)");
  const planned = new Set(s.plan.map((r) => base(r.old)));
  const missing = scanned.filter((n) => !planned.has(n));
  if (missing.length) throw new Error(`I2 ocr: scanned files not planned: ${missing.join(", ")}`);
  return s;
}

/** vision: page images were sent to the vision model only on weak OCR. */
export async function vision(s: Session): Promise<Session> {
  await ensure(s);
  throw new Skipped(
    "I2 vision: which read method fed Stage 2 is not recorded in .docnamer-plan.json",
  );
}

// --- I3: Collision-safe unique naming -----------------------------------------

/** render: template rendered, empty parts dropped, name sanitised. */
export async function render(s: Session): Promise<Session> {
  await ensure(s);
  for (const r of s.plan) {
    if (/\s{2,}/.test(r.new) || /^[\s_-]|[\s_-]$/.test(r.new)) {
      throw new Error(`I3 render: name has an empty template part: ${JSON.stringify(r.new)}`);
    }
    if (/[/\\:*?"<>|]/.test(r.new)) throw new Error(`I3 render: name not sanitised: ${r.new}`);
  }
  return s;
}

/** collide: no two rows propose the same name. */
export async function collide(s: Session): Promise<Session> {
  await ensure(s);
  const seen = new Map<string, string>();
  for (const r of s.plan) {
    const key = r.new.toLowerCase();
    const prev = seen.get(key);
    if (prev) throw new Error(`I3 collide: ${r.old} and ${prev} both propose ${r.new}`);
    seen.set(key, r.old);
  }
  return s;
}

/** suffix: a ` (n)` suffix always follows a base name that is taken. */
export async function suffix(s: Session): Promise<Session> {
  await ensure(s);
  const proposed = new Set(s.plan.map((r) => r.new.toLowerCase()));
  for (const r of s.plan) {
    const m = r.new.match(/^(.*) \((\d+)\)(\.[^.]*)?$/);
    if (!m) continue;
    const stem = (m[1] + (m[3] ?? "")).toLowerCase();
    if (!proposed.has(stem) && !s.originals.has(stem)) {
      throw new Error(`I3 suffix: ${r.new} has a suffix but no colliding base`);
    }
  }
  return s;
}
