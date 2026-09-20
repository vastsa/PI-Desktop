import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const surfaceSource = await readFile(
  new URL("../src/components/ChatSurface.tsx", import.meta.url),
  "utf8",
);
const handleSource = await readFile(
  new URL("../src/components/ConversationWidthHandles.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("chat surface mounts dual width handles", () => {
  assert.match(surfaceSource, /<ConversationWidthHandles \/>/);
  assert.match(handleSource, /data-testid=\{`chat-width-handle-\$\{side\}`\}/);
  assert.match(handleSource, /chatContentWidthFromDrag/);
  assert.match(handleSource, /DEFAULT_CHAT_CONTENT_MAX_WIDTH/);
  assert.match(handleSource, /onDoubleClick=\{onDoubleClick\}/);
  assert.match(handleSource, /nav\.resizeChatWidth/);
});

test("chat width handles are invisible at rest and show a quiet capsule on hover", () => {
  const handle = styles.match(/\.chat-width-handle::before\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(handle, /opacity:\s*0/);
  assert.match(handle, /height:\s*40px/);
  assert.match(handle, /var\(--ds-text-primary\) 18%/);
  assert.doesNotMatch(handle, /box-shadow:\s*0 0 12px/);
  assert.match(styles, /\.chat-width-handle:hover::before/);
  assert.match(
    styles,
    /:root\[data-theme="light"\] \.chat-width-handle::before/,
  );
  assert.match(
    styles,
    /\.chat-surface\[data-chat-resizing="true"\] \.chat-width-handle::before/,
  );
});


test("a squeezed pane keeps min\(100%, preferred\) and does not force 640px", () => {
  assert.match(styles, /--chat-content-max-width:\s*760px/);
  assert.doesNotMatch(
    styles,
    /\.app-shell\.sidebar-collapsed \.main-pane\s*\{[\s\S]*?--chat-content-max-width:\s*640px/,
  );
  assert.match(
    styles,
    /\.thread-content\s*\{[\s\S]*?width:\s*min\(100%,\s*var\(--chat-content-max-width\)\)/,
  );
});
test("dragging the width also scales the per-message prose width", () => {
  // The drag handler publishes the preferred width to every width consumer so
  // the message rows track the band (see applyPreferredWidth). Previously the
  // band widened while --chat-prose-max-width stayed frozen at the .main-pane
  // default of 760px.
  assert.match(
    handleSource,
    /setProperty\("--chat-content-max-width",\s*px\)/,
  );
  assert.match(
    handleSource,
    /setProperty\("--chat-composer-max-width",\s*px\)/,
  );
  assert.match(
    handleSource,
    /setProperty\("--chat-prose-max-width",\s*px\)/,
  );
  // The prose fallback must stay aligned with the banner default so a
  // non-dragged surface still renders both at the same width.
  assert.match(
    styles,
    /--chat-prose-max-width:\s*var\(--chat-content-max-width\)/,
  );
});
