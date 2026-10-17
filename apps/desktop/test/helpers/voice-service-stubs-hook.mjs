/**
 * Module hooks for importing the real voice-service.ts under `node --test`.
 *
 * The service uses constructor parameter properties, which node's strip-only
 * TypeScript mode rejects, and vite's ssrLoadModule runs modules in an
 * isolated realm whose global timers a test cannot mock — both dead ends for
 * fake-clock coverage. So instead: resolve redirects `electron` and
 * `@pi-desktop/voice-runtime` to test stubs and maps bundler-style `.js`
 * specifiers to their `.ts` siblings, and load transforms `.ts` with
 * esbuild (via vite's exported transformWithEsbuild) so the module executes
 * on the test's own ESM pipeline and realm.
 *
 * Register with:
 *   register(new URL("./helpers/voice-service-stubs-hook.mjs", import.meta.url).href);
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { resolve as resolveTypeScriptSibling } from "./ts-import-hooks.mjs";

const stubs = new Map([
  ["electron", new URL("./electron-voice-stub.mjs", import.meta.url).href],
  [
    "@pi-desktop/voice-runtime",
    new URL("./voice-runtime-stub.mjs", import.meta.url).href,
  ],
]);

export async function resolve(specifier, context, next) {
  const stub = stubs.get(specifier);
  if (stub) {
    return next(stub, { ...context, parentURL: undefined });
  }
  return resolveTypeScriptSibling(specifier, context, next);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) {
    return nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(url), "utf8");
  const { code } = await transformWithEsbuild(source, url, {
    loader: "ts",
    format: "esm",
  });
  return { format: "module", shortCircuit: true, source: code };
}
