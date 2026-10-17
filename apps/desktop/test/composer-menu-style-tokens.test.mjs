import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const menus = readFileSync(new URL("../src/styles/composer-menus.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`));
  assert.ok(match, `missing CSS declaration: ${property}`);
  return match[1].trim().replace(/\s+/g, " ");
}

test("composer model chip uses the existing single-line height token", () => {
  assert.equal(
    declaration(rule(menus, ".composer-model-thinking-chip"), "line-height"),
    "var(--leading-none)",
  );
  assert.equal(declaration(rule(tokens, "@theme"), "--leading-none"), "1");
});

test("light model menu token preserves its opaque surface and original shadow", () => {
  const menu = rule(menus, ':root[data-theme="light"] .composer-model-menu');
  assert.equal(declaration(menu, "background"), "var(--ds-bg-elevated-opaque)");
  assert.equal(declaration(menu, "backdrop-filter"), "none");
  assert.equal(declaration(menu, "-webkit-backdrop-filter"), "none");
  assert.equal(declaration(menu, "box-shadow"), "var(--ds-shadow-model-menu)");
  assert.equal(
    declaration(rule(tokens, ':root[data-theme="light"]'), "--ds-shadow-model-menu"),
    "0 0 0 0.5px color-mix(in oklab, #1a1c1f 10%, transparent), " +
      "0 8px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.06)",
  );
});
