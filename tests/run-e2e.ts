/**
 * `test:e2e` runner. `bun run test:e2e` runs every tests/**\/*.spec.ts; with file
 * arguments it runs exactly those files (`bun run test:e2e tests/foo.spec.ts`).
 *
 * Spec files receive a global `flow(name, fn)`: `fn` resolves to pass, throws to
 * fail, or throws a `Skipped` (carrying `skip === true`) to report a named hole
 * without going green. The runner exits non-zero only on a real failure.
 */

let failed = 0;
let skipped = 0;

(globalThis as unknown as { flow: unknown }).flow = async (name: string, fn: unknown) => {
  if (typeof fn !== "function") {
    if (fn) console.info("FLOW PASSED: " + name);
    else {
      console.error("FLOW FAILED: " + name);
      failed++;
    }
    return;
  }
  try {
    await (fn as () => unknown)();
    console.info("FLOW PASSED: " + name);
  } catch (e) {
    const err = e as { skip?: boolean; claim?: string; stack?: string };
    if (err && err.skip === true) {
      console.info("FLOW SKIPPED: " + name + " — " + (err.claim ?? "unobservable"));
      skipped++;
      return;
    }
    console.error("FLOW FAILED: " + name + ": " + (err?.stack ?? e));
    failed++;
  }
};

const repo = import.meta.dir.replace(/\/tests$/, "");

async function discover(): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("**/*.spec.ts").scan({ cwd: `${repo}/tests` })) {
    out.push(`${repo}/tests/${rel}`);
  }
  return out.sort();
}

function abs(f: string): string {
  return f.startsWith("/") ? f : `${process.cwd()}/${f}`;
}

const args = process.argv.slice(2);
const files = args.length ? args.map(abs) : await discover();
for (const f of files) await import(f);

console.info(`\n${failed} failed, ${skipped} skipped, ${files.length} spec file(s)`);
process.exit(failed ? 1 : 0);
