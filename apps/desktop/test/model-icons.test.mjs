import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [source, sprite] = await Promise.all([
  readFile(resolve(root, "src/lib/model-icons.tsx"), "utf8"),
  readFile(resolve(root, "public/provider-icons.svg"), "utf8"),
]);

test("model icon lookup prefers model names and falls back to provider icons", () => {
  assert.match(source, /MODEL_ICON_RULES/);
  assert.match(source, /MODEL_ICON_RULES\.find\(\(\[pattern\]\)/);
  assert.match(source, /PROVIDER_ICONS\[provider\.trim\(\)\.toLowerCase\(\)\]/);
  assert.match(source, /\(\?:\\bqwen\(\?:\\d\+\(\?:\\.\\d\+\)\*\)\?\\b\|通义\)/);
  assert.match(source, /\(\?:\\b\(\?:glm\|chatglm\)\\b\|智谱\)/);
});

test("all model icon symbols exist in the packaged relative sprite", () => {
  assert.match(source, /href=\{`\.\/provider-icons\.svg#\$\{symbol\}`\}/);
  assert.doesNotMatch(source, /href=\{`\/provider-icons\.svg/);
  const symbols = [
    ...source.matchAll(/symbol:\s*"([^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(symbols.length > 0);
  for (const symbol of symbols) {
    assert.match(sprite, new RegExp(`<symbol id="${symbol}"`));
  }
});
