import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Resolve the compiler used by Desktop's actual Vite instance, not a test mock.
const desktopRequire = createRequire(new URL("../package.json", import.meta.url));
const viteRequire = createRequire(await realpath(desktopRequire.resolve("vite/package.json")));
const { rollup } = await import(pathToFileURL(viteRequire.resolve("rollup")));

test("Desktop compiler preserves external namespace exports reached by dynamic import", async () => {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "rollup-namespace-"));
  let bundle;
  try {
    await writeFile(join(root, "node.mjs"), `import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
export { child_process, fs };\n`);
    await writeFile(join(root, "entry.mjs"), `import { fs } from './node.mjs';
export const exists = fs.existsSync;
export async function load() { return await import('./node.mjs'); }\n`);
    bundle = await rollup({ input: join(root, "entry.mjs"), external: id => id.startsWith("node:") });
    const { output } = await bundle.generate({ format: "es" });
    const entry = output.find(chunk => chunk.type === "chunk" && chunk.isEntry);
    assert(entry);
    for (const chunk of output) {
      assert.equal(chunk.type, "chunk");
      await writeFile(join(root, chunk.fileName), chunk.code);
    }
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const syntax = spawnSync(process.execPath, ["--check", join(root, entry.fileName)], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    const result = await import(pathToFileURL(join(root, entry.fileName)));
    assert.equal(result.exists(join(root, "entry.mjs")), true);
    assert.equal(typeof (await result.load()).child_process.spawn, "function");
    assert.equal((await result.load()).fs.existsSync, result.exists);
  } finally {
    await bundle?.close();
    await rm(root, { recursive: true, force: true });
  }
});
