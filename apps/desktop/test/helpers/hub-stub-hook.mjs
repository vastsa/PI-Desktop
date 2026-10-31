/**
 * Module hooks for importing packages/voice-runtime sources under
 * `node --test`: `@huggingface/hub` is redirected to the controllable stub,
 * and `.ts` sources are esbuild-transformed (via vite's exported
 * transformWithEsbuild) onto the test's own ESM pipeline, so plain node
 * builds without native type-stripping can run them.
 *
 * Register with:
 *   register(new URL("./helpers/hub-stub-hook.mjs", import.meta.url).href);
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { resolve as resolveTypeScriptSibling } from "./ts-import-hooks.mjs";

const hubStub = new URL("./hub-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "@huggingface/hub") {
    return next(hubStub, { ...context, parentURL: undefined });
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
