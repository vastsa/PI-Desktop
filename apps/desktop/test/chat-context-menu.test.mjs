import assert from "node:assert/strict";
import test from "node:test";
import { placeControlContextMenu, placeContextMenu } from "../src/lib/context-menu.ts";
import { conversationPlainText, copySelectionOrFallback } from "../src/lib/chat-transcript-text.ts";

test("a menu that fits the viewport stays at the pointer", () => {
  assert.deepEqual(
    placeContextMenu({ x: 120, y: 80 }, { width: 184, height: 160 }, { width: 800, height: 600 }),
    { left: 120, top: 80 },
  );
});

test("a menu near the far edge clamps inside the viewport margin", () => {
  assert.deepEqual(
    placeContextMenu({ x: 790, y: 590 }, { width: 184, height: 160 }, { width: 800, height: 600 }),
    { left: 608, top: 432 },
  );
});

test("a surface larger than the viewport still stays reachable at the margin", () => {
  assert.deepEqual(
    placeContextMenu({ x: 400, y: 300 }, { width: 900, height: 700 }, { width: 800, height: 600 }),
    { left: 8, top: 8 },
  );
});

test("copy conversation keeps speaking turns and skips tool rows", () => {
  const text = conversationPlainText(
    [
      { role: "user", content: "Fix the crash" },
      { role: "tool", content: "{\"ok\":true}" },
      { role: "assistant", content: "Patched `main.ts`." },
      { role: "system", content: "session started" },
      { role: "user", content: "   " },
    ],
    { user: "You", assistant: "Assistant" },
  );
  assert.equal(text, "You:\nFix the crash\n\nAssistant:\nPatched `main.ts`.");
});

test("an empty conversation copies nothing so the action can stay disabled", () => {
  assert.equal(
    conversationPlainText(
      [{ role: "tool", content: "noise" }, { role: "assistant", content: "" }],
      { user: "You", assistant: "Assistant" },
    ),
    "",
  );
});

test("copy prefers a live selection over the whole turn", () => {
  assert.equal(copySelectionOrFallback("  this line  ", "whole message"), "  this line  ");
  assert.equal(copySelectionOrFallback("", "whole message"), "whole message");
  assert.equal(copySelectionOrFallback(undefined, "whole message"), "whole message");
});

test("control menus align to the button right/bottom, not the click point", () => {
  assert.deepEqual(placeControlContextMenu({ left: 700, right: 724, top: 40, bottom: 64 }, { width: 160, height: 120 }, { width: 800, height: 600 }), { left: 564, top: 68 });
});
test("control menus flip upward at the bottom and stay reachable in tiny viewports", () => {
  assert.deepEqual(placeControlContextMenu({ left: 770, right: 794, top: 560, bottom: 584 }, { width: 160, height: 120 }, { width: 800, height: 600 }), { left: 632, top: 436 });
  assert.deepEqual(placeControlContextMenu({ left: 10, right: 34, top: 30, bottom: 54 }, { width: 160, height: 120 }, { width: 100, height: 80 }), { left: 8, top: 8 });
});
