import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
  buildConversationMinimapMarkers,
  shouldRenderConversationMinimap,
} = await import("../src/lib/conversation-minimap.ts");

function message(id, role, content) {
  return {
    id,
    role,
    content,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

test("keeps the outline available while earlier history is outside the mounted window", () => {
  assert.equal(
    shouldRenderConversationMinimap({
      markerCount: 0,
      overflows: false,
      hasEarlier: true,
    }),
    true,
  );
});

test("keeps the completed one-page outline hidden", () => {
  assert.equal(
    shouldRenderConversationMinimap({
      markerCount: 4,
      overflows: false,
      hasEarlier: false,
    }),
    false,
  );
});

test("shows a completed outline only with enough markers and overflow", () => {
  assert.equal(
    shouldRenderConversationMinimap({
      markerCount: 2,
      overflows: true,
      hasEarlier: false,
    }),
    true,
  );
  assert.equal(
    shouldRenderConversationMinimap({
      markerCount: 1,
      overflows: true,
      hasEarlier: false,
    }),
    false,
  );
});

test("marks only user messages", () => {
  const markers = buildConversationMinimapMarkers([
    message("user-1", "user", "First question"),
    message("assistant-1a", "assistant", "First sentence."),
    message("tool-1", "tool", "tool output"),
    message("assistant-1b", "assistant", "Second sentence."),
    message("user-2", "user", "Second question"),
    message("assistant-2", "assistant", "Second response."),
  ]);

  assert.deepEqual(markers, [
    { id: "user-1", preview: "First question" },
    { id: "user-2", preview: "Second question" },
  ]);
});

test("caps the user preview", () => {
  const markers = buildConversationMinimapMarkers([
    message("user-1", "user", "a".repeat(400)),
  ]);

  assert.equal(
    markers[0].preview.length,
    CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
  );
});
