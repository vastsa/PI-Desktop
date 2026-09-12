import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  ClipboardHistory,
  CLIPBOARD_HISTORY_MAX_ENTRIES,
  CLIPBOARD_HISTORY_MAX_TEXT_BYTES,
  CLIPBOARD_HISTORY_RETENTION_MS,
} = await import("../electron/main/clipboard-history.ts");

test("clipboard history records explicit text and image captures and clones bytes", () => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const history = new ClipboardHistory({ now: () => now });

  history.recordText("hello");
  now += 1000;
  history.recordImage({
    format: "png",
    data: new Uint8Array([1, 2, 3]),
    width: 2,
    height: 3,
  });

  const result = history.getHistory();
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "image");
  assert.deepEqual([...result[0].data], [1, 2, 3]);
  assert.equal(result[1].type, "text");

  result[0].data[0] = 99;
  assert.deepEqual([...history.getHistory()[0].data], [1, 2, 3]);
});

test("history does not read or poll the system clipboard", () => {
  const history = new ClipboardHistory();
  assert.equal(typeof history.start, "undefined");
  assert.equal(typeof history.poll, "undefined");
  assert.equal(typeof history.stop, "undefined");
});

test("consecutive duplicates refresh the timestamp without creating entries", () => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const history = new ClipboardHistory({ now: () => now });

  history.recordText("same");
  now += 5000;
  history.recordText("same");

  const result = history.getHistory();
  assert.equal(result.length, 1);
  assert.equal(result[0].capturedAt, new Date(now).toISOString());
});

test("an expired duplicate can be recorded again", () => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const history = new ClipboardHistory({ now: () => now });

  history.recordText("expires");
  now += CLIPBOARD_HISTORY_RETENTION_MS + 1;
  assert.deepEqual(history.getHistory(), []);
  history.recordText("expires");

  assert.equal(history.getHistory().length, 1);
});

test("history skips oversized text and enforces the entry cap", () => {
  const history = new ClipboardHistory();
  history.recordText("x".repeat(CLIPBOARD_HISTORY_MAX_TEXT_BYTES + 1));
  assert.deepEqual(history.getHistory(), []);

  for (let index = 0; index < CLIPBOARD_HISTORY_MAX_ENTRIES + 1; index += 1) {
    history.recordText(`entry-${index}`);
  }
  const result = history.getHistory();
  assert.equal(result.length, CLIPBOARD_HISTORY_MAX_ENTRIES);
  assert.equal(result[0].type, "text");
  assert.equal(result[0].text, `entry-${CLIPBOARD_HISTORY_MAX_ENTRIES}`);
  assert.equal(result.at(-1).text, "entry-1");
});
