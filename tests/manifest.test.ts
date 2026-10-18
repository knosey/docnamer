import { test, expect } from "bun:test";

/** Read a repo-root file, or null when it is not there yet — a failed check, never a throw. */
async function readRepoFile(name: string): Promise<string | null> {
  const file = Bun.file(new URL(`../${name}`, import.meta.url));
  return (await file.exists()) ? await file.text() : null;
}

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
