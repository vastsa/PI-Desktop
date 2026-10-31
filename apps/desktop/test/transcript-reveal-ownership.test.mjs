import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { transcriptRevealOwnership } = await import(
  "../src/lib/transcript-reading-position.ts"
);

const bookmark = (pinned) => ({
  pinned,
  messageId: "m1",
  offset: 24,
  scrollTop: 480,
  windowSize: 20,
});
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("an unpinned bookmark owns a reveal even when follow still reads pinned", () => {
  assert.equal(
    transcriptRevealOwnership(bookmark(false), false, true),
    "reading-position",
  );
});

test("a pending restore owns the reveal", () => {
  assert.equal(transcriptRevealOwnership(undefined, true, true), "reading-position");
});

test("a pinned pane without a bookmark bottoms", () => {
  assert.equal(transcriptRevealOwnership(undefined, false, true), "pinned");
});

test("an unpinned pane without a bookmark reapplies its retained offset", () => {
  assert.equal(transcriptRevealOwnership(undefined, false, false), "retained");
  assert.equal(transcriptRevealOwnership(bookmark(true), false, false), "retained");
});

test("both transcript hooks route the reveal edge through the shared rule", async () => {
  const [readingHook, scrollHook] = await Promise.all([
    read("../src/hooks/use-transcript-reading-position.ts"),
    read("../src/features/chat/transcript/hooks/useTranscriptScroll.ts"),
  ]);
  // The bookmark, not the possibly stale follow flag, claims an unpinned
  // reveal; the old `!pinnedRef.current` gate let follow bottom it (#1771).
  assert.match(
    readingHook,
    /bookmark\?\.pinned === false[\s\S]*?pendingRef\.current = bookmark[\s\S]*?pinnedRef\.current = false/,
  );
  assert.doesNotMatch(
    readingHook,
    /!wasVisibleRef\.current && !pinnedRef\.current/,
  );
  assert.match(scrollHook, /transcriptRevealOwnership\(/);
  assert.match(
    scrollHook,
    /ownership === "reading-position"[\s\S]*?pinnedRef\.current = false/,
  );
});
