import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * Slot mounts own layout, not the plugin. A plugin page that establishes its
 * own container (`container-type: inline-size`, needed for its container
 * queries) contributes no intrinsic inline size, so an `inline-flex` mount
 * collapsed the whole page to its padding. Keep the block-level slots
 * block-level; this is the rule the entry-extra clamp and main pages rely on.
 */
const slotShell = readFileSync(
  new URL("../src/plugins/renderer-slots/slot-shell.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of `selector`, which may sit in a selector group. */
function rule(selector) {
  const at = slotShell.indexOf(selector);
  assert.ok(at >= 0, `missing CSS rule: ${selector}`);
  const open = slotShell.indexOf("{", at);
  const close = slotShell.indexOf("}", open);
  assert.ok(open > at && close > open, `unterminated CSS rule: ${selector}`);
  return slotShell.slice(open + 1, close);
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`));
  assert.ok(match, `missing CSS declaration: ${property}`);
  return match[1].trim().replace(/\s+/g, " ");
}

test("block-level slots take their host region instead of sizing to content", () => {
  for (const block of ["entryExtra", "toolCard", "blockRenderer"]) {
    const body = rule(`.pi-plugin-slot[data-pi-slot="${block}"]`);
    assert.equal(declaration(body, "display"), "block", `${block} stays block`);
    assert.equal(declaration(body, "width"), "100%", `${block} fills its row`);
  }
});

test("a main page fills its route surface and owns its own overflow", () => {
  const body = rule('.pi-plugin-slot[data-pi-slot="mainPage"]');
  assert.equal(declaration(body, "display"), "block");
  assert.equal(declaration(body, "flex"), "1 1 auto");
  assert.equal(declaration(body, "min-width"), "0");
  assert.equal(declaration(body, "min-height"), "0");
});

test("a navigation section spans the sidebar column", () => {
  const body = rule('.pi-plugin-slot[data-pi-slot="navigationSection"]');
  assert.equal(declaration(body, "display"), "block");
  assert.equal(declaration(body, "width"), "100%");
  assert.equal(declaration(body, "min-width"), "0");
});
