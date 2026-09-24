/**
 * Issue #795 ③: a durable window read that reports "no messages" for a session
 * the sidebar counts as having history must not become the committed truth.
 *
 * The host answers `session.get` from a transcript file it may be rewriting, so
 * "the session exists, with no messages" is a legal looking answer for a
 * 2 700-message session. Caching it let the sidebar's hover prefetch re-serve
 * that emptiness on every later open, and the pane stayed blank until restart.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { sessionReadLooksEmpty } = await import(
  pathToFileURL(join(here, "../src/lib/session-transcript-read.ts")).href
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [sessionSlice, sessionRuntime, composerStyle] = await Promise.all([
  read("../src/stores/slices/session-slice.ts"),
  read("../src/stores/runtime/session-runtime.ts"),
  read("../src/lib/session-transcript-read.ts"),
]);

test("only a session whose own count agrees may be read as empty", () => {
  assert.equal(sessionReadLooksEmpty({ messages: [], messageCount: 2700 }), true);
  assert.equal(
    sessionReadLooksEmpty({ messages: [], messageCount: 1 }),
    true,
    "one counted message is still history",
  );
  assert.equal(
    sessionReadLooksEmpty({ messages: [], messageCount: 0 }),
    false,
    "a session that was never used may legitimately read empty",
  );
  assert.equal(
    sessionReadLooksEmpty({ messages: [{ id: "m1" }], messageCount: 0 }),
    false,
  );
  assert.equal(sessionReadLooksEmpty({ messages: undefined, messageCount: 4 }), true);
  assert.equal(sessionReadLooksEmpty(null), false);
  assert.equal(sessionReadLooksEmpty(undefined), false);
});

test("the empty read is retried once and then recovered instead of committed", () => {
  assert.match(composerStyle, /export function sessionReadLooksEmpty\(/);
  assert.match(
    sessionSlice,
    /sessionReadLooksEmpty\(detail\.session\)[\s\S]{0,600}?await runtime\.loadSessionDetail\(id, \{/,
    "an empty durable window must be read once more",
  );
  assert.match(
    sessionSlice,
    /sessionReadLooksEmpty\(reread\.session\)[\s\S]{0,500}?retained && retained\.length > 0[\s\S]{0,200}?commitSelection\(retained, true\)/,
    "a still-empty read keeps what the user already has",
  );
  assert.match(
    sessionSlice,
    /showToast\(i18n\.t\("chat\.sessionTranscriptEmpty"\)/,
    "a blank pane must stay diagnosable",
  );
  assert.doesNotMatch(
    sessionSlice,
    /commitSelection\(\[\], false/,
    "no path may commit an empty durable window as the active transcript",
  );
});

test("the durable-read cache never stores a suspiciously empty window", () => {
  assert.match(
    sessionRuntime,
    /if \(messages\.length > 0 \|\| !sessionReadLooksEmpty\(detail\.session\)\) \{\s*cacheSessionTranscript\(/,
    "hover prefetch shares this cache boundary and must not poison it",
  );
});

test("both shipped locales carry the diagnosable copy", async () => {
  const [en, zhCN] = await Promise.all([
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);
  assert.match(en, /sessionTranscriptEmpty:\s*"[^"]+"/);
  assert.match(zhCN, /sessionTranscriptEmpty:\s*"[^"]+"/);
});
