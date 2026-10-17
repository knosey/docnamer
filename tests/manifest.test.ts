// THE TRUTH THIS TEST COMPARES AGAINST, swapped by the graph runner through GRAPH_REFERENCE to prove the
// verdict follows it: keep this constant as it is and assert against it.
export const reference = process.env.GRAPH_REFERENCE ?? String.raw`bun --version`

import { test, expect } from "bun:test";

/** Run this node's reference command; the verdict must follow its output. */
function runReference(): { code: number; out: string } {
  const proc = Bun.spawnSync(["sh", "-c", reference]);
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString().trim() };
}

/** Read a repo-root file, or null when it is not there yet — a failed check, never a throw. */
async function readRepoFile(name: string): Promise<string | null> {
  const file = Bun.file(new URL(`../${name}`, import.meta.url));
  return (await file.exists()) ? await file.text() : null;
}

test("reference: the runtime probe exits 0 with a version", () => {
  const { code, out } = runReference();
  expect(code).toBe(0);
  expect(out).toMatch(/^\d+\.\d+\.\d+/);
});

test("manifest: package.json declares type module", async () => {
  const text = await readRepoFile("package.json");
  expect(text).not.toBeNull();
  const pkg = JSON.parse(text ?? "{}") as { type?: unknown };
  expect(pkg.type).toBe("module");
});

test("manifest: @earendil-works/pi-ai is pinned at exactly 1.3.0", async () => {
  const text = await readRepoFile("package.json");
  expect(text).not.toBeNull();
  const pkg = JSON.parse(text ?? "{}") as { dependencies?: Record<string, string> };
  expect(pkg.dependencies?.["@earendil-works/pi-ai"]).toBe("1.3.0");
});
