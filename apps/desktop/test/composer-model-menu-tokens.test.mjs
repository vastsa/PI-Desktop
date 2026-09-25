import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const menus = await readFile(new URL("../src/styles/composer-menus.css", import.meta.url), "utf8");
const tokens = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function rule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing CSS rule: ${selector}`);
  const opening = source.indexOf("{", start);
  const closing = source.indexOf("}", opening);
  assert.notEqual(closing, -1, `Unclosed CSS rule: ${selector}`);
  return source.slice(opening + 1, closing);
}

test("the model-thinking chip keeps its unit line height through the shared token", () => {
  assert.match(rule(menus, ".composer-model-thinking-chip"), /line-height:\s*var\(--leading-none\);/);
  assert.match(rule(tokens, "@theme"), /--leading-none:\s*1;/);
});

test("the light model menu keeps its three shadow layers in a surface token", () => {
  const lightMenu = rule(menus, ':root[data-theme="light"] .composer-model-menu');
  assert.match(lightMenu, /box-shadow:\s*var\(--ds-shadow-model-menu\);/);
  const lightTokens = rule(tokens, ':root[data-theme="light"]');
  const shadow = lightTokens.match(/--ds-shadow-model-menu:\s*([^;]+);/);
  assert.ok(shadow, "The light theme must define the model-menu shadow token");
  assert.equal(shadow[1].replace(/\s+/g, " ").trim(), [
    "0 0 0 0.5px color-mix(in oklab, #1a1c1f 10%, transparent)",
    "0 8px 32px rgba(0, 0, 0, 0.1)",
    "0 2px 8px rgba(0, 0, 0, 0.06)",
  ].join(", "));
});
