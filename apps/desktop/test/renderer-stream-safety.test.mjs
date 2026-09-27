import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptSource = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const rendererHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);

test("streaming content does not add a renderer-side state update loop", () => {
  assert.match(transcriptSource, /const displayed = message\.content \|\| "";/);
  assert.doesNotMatch(transcriptSource, /useTypewriter|setVisibleLen|requestAnimationFrame\(tick\)/);
});

test("renderer CSP permits only local and bundled data fonts", () => {
  assert.match(rendererHtml, /font-src 'self' data:;/);
  assert.doesNotMatch(rendererHtml, /font-src[^;]*https?:/);
});
