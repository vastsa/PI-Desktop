import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
  buildConversationMinimapMarkers,
  shouldRenderConversationMinimap,
} from "../src/lib/conversation-minimap.ts";

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

test("uses one assistant marker for all response fragments in a user turn", () => {
  const markers = buildConversationMinimapMarkers([
    message("user-1", "user", "First question"),
    message("assistant-1a", "assistant", "First sentence."),
    message("tool-1", "tool", "tool output"),
    message("assistant-1b", "assistant", "Second sentence."),
    message("user-2", "user", "Second question"),
    message("assistant-2", "assistant", "Second response."),
  ]);

  assert.deepEqual(
    markers.map(({ id, role }) => ({ id, role })),
    [
      { id: "user-1", role: "user" },
      { id: "assistant-1a", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant" },
    ],
  );
  assert.equal(markers[1].preview, "First sentence.\n\nSecond sentence.");
});

test("starts the assistant marker at the first contentful response fragment", () => {
  const markers = buildConversationMinimapMarkers([
    message("user-1", "user", "Question"),
    { ...message("thinking", "assistant", ""), thinking: "Reasoning" },
    message("tool-1", "tool", "tool output"),
    message("answer", "assistant", "Final answer"),
  ]);

  assert.deepEqual(markers.map((marker) => marker.id), ["user-1", "answer"]);
});

test("caps the combined assistant preview", () => {
  const markers = buildConversationMinimapMarkers([
    message("user-1", "user", "Question"),
    message("assistant-1a", "assistant", "a".repeat(200)),
    message("assistant-1b", "assistant", "b".repeat(200)),
  ]);

  assert.equal(
    markers[1].preview.length,
    CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
  );
});
