import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assistantTurnPartsSource = await readFile(
  new URL("../src/features/chat/transcript/AssistantTurnParts.tsx", import.meta.url),
  "utf8",
);
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);

test("streaming cursor remains steady throughout active streaming without flapping", () => {
  // Must not flap on/off between network chunks when buffer catches up with current source length
  assert.match(assistantTurnPartsSource, /const visible = useTranscriptVisibility\(\);/);
  assert.match(
    assistantTurnPartsSource,
    /const showCursor = streaming && enabled && visible && Boolean\(displayContent\);/,
  );
  assert.doesNotMatch(
    assistantTurnPartsSource,
    /displayContent\.length < \(message\.content \|\| ""\)\.length/,
  );
});

test("streaming prose chat stabilizes line wrapping against orphan-rebalancing reflow", () => {
  assert.match(
    messagesCss,
    /\.assistant-turn-fragment\.streaming \.prose-chat\s*\{\s*text-wrap:\s*wrap;\s*\}/,
  );
});

test("streaming cursor attaches to inline leaf blocks and list items instead of container lists", () => {
  // List cursor must be placed on inline content, never on nested ul/ol containers.
  assert.match(
    messagesCss,
    /\.assistant-turn-fragment\.smooth-cursor \.prose-chat > :is\(ul, ol\):last-child li:last-child:not\(:has\(ul, ol\)\):not\(:has\(p\)\)::after/,
  );
  assert.match(
    messagesCss,
    /\.assistant-turn-fragment\.smooth-cursor \.prose-chat > :is\(ul, ol\):last-child li:last-child > p:last-child::after/,
  );
  assert.doesNotMatch(messagesCss, /li:last-child > :last-child::after/);
  assert.match(
    messagesCss,
    /\.assistant-turn-fragment\.smooth-cursor \.prose-chat > :last-child:not\(ul\):not\(ol\)/,
  );
});
