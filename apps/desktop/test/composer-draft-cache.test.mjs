import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HOME_DRAFT_KEY,
  captureComposerDraft,
  deleteComposerDraft,
  draftKeyForSession,
  draftOwnerSessionId,
  pruneComposerDrafts,
  readComposerDraft,
  resetComposerDraftCache,
  snapshotComposerDraft,
  writeComposerDraft,
} from "../src/lib/composer-draft-cache.ts";

const composer = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

test.afterEach(() => {
  resetComposerDraftCache();
});

test("draft keys isolate the home slot from a session id", () => {
  assert.equal(draftKeyForSession(null), HOME_DRAFT_KEY);
  assert.equal(draftKeyForSession(undefined), HOME_DRAFT_KEY);
  assert.equal(draftKeyForSession("sess-1"), "sess-1");
  assert.equal(draftOwnerSessionId(HOME_DRAFT_KEY), "");
  assert.equal(draftOwnerSessionId("sess-1"), "sess-1");
});

test("home snapshots keep file references owned by the empty session id", () => {
  const snapshot = snapshotComposerDraft(
    "see this",
    [
      { sessionId: "", path: "/tmp/a.txt", name: "a.txt", kind: "file", token: "\uE000" },
      { sessionId: "other", path: "/tmp/b.txt", name: "b.txt", kind: "file" },
    ],
    HOME_DRAFT_KEY,
  );
  assert.equal(snapshot.text, "see this");
  assert.deepEqual(snapshot.fileReferences, [
    { path: "/tmp/a.txt", name: "a.txt", kind: "file", token: "\uE000" },
  ]);
});

test("the module cache survives a Composer remount", () => {
  captureComposerDraft("sess-a", "draft A", []);
  captureComposerDraft(HOME_DRAFT_KEY, "home draft", [
    { sessionId: "", path: "/tmp/note.txt", name: "note.txt", kind: "file" },
  ]);
  // A remount is just another reader of the same map.
  assert.equal(readComposerDraft("sess-a")?.text, "draft A");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "home draft");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.fileReferences[0]?.name, "note.txt");
});

test("pruning drops deleted sessions and keeps home plus the live key", () => {
  writeComposerDraft("gone", { text: "stale", fileReferences: [] });
  writeComposerDraft("kept", { text: "live", fileReferences: [] });
  writeComposerDraft(HOME_DRAFT_KEY, { text: "home", fileReferences: [] });
  pruneComposerDrafts([HOME_DRAFT_KEY, "kept"]);
  assert.equal(readComposerDraft("gone"), undefined);
  assert.equal(readComposerDraft("kept")?.text, "live");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "home");
});

test("deleting a slot does not clear a different session", () => {
  captureComposerDraft("a", "alpha", []);
  captureComposerDraft("b", "beta", []);
  deleteComposerDraft("a");
  assert.equal(readComposerDraft("a"), undefined);
  assert.equal(readComposerDraft("b")?.text, "beta");
});

test("composer hydrates from the shared cache and persists across unmount and hidden windows", () => {
  assert.match(composer, /from "\.\.\/lib\/composer-draft-cache"/);
  assert.match(composer, /readComposerDraft\(draftKey\)/);
  assert.match(composer, /useState\(\(\) => initialDraft\?\.text \?\? ""\)/);
  assert.match(composer, /persistDraft\(draftKeyRef\.current\)/);
  assert.match(composer, /document\.visibilityState === "hidden"/);
  assert.match(composer, /window\.addEventListener\("blur", onWindowBlur\)/);
  assert.match(composer, /window\.addEventListener\("focus", onVisibility\)/);
  assert.match(composer, /paintCurrentDraft\(el, expected\)/);
  assert.match(composer, /const previousKey = draftKeyRef\.current/);
  assert.match(composer, /persistDraft\(previousKey\)/);
  assert.match(composer, /const nextDraft = readComposerDraft\(draftKey\)/);
  assert.match(composer, /setValue\(nextDraft\?\.text \?\? ""\)/);
  assert.match(composer, /setFileReferences\(\s*nextDraft\?\.fileReferences\.map/);
  assert.doesNotMatch(composer, /new Map<string, ComposerDraftSnapshot>\(\)/);
  assert.doesNotMatch(composer, /draftCacheRef/);
});

test("composer handles home drafts, deleted sessions, and async sends by key", () => {
  assert.match(composer, /pruneComposerDrafts\(\[/);
  assert.match(composer, /HOME_DRAFT_KEY,/);
  assert.match(composer, /const clearDraftForKey = \(key: string\)/);
  assert.match(composer, /deleteComposerDraft\(key\)/);
  assert.match(composer, /draftKeyForSession\(useAppStore\.getState\(\)\.activeSessionId\)/);
  assert.match(composer, /const submittedDraftKey = draftKey/);
  assert.match(composer, /clearDraftForKey\(submittedDraftKey\)/);
  assert.doesNotMatch(composer, /if \(accepted\) clearDraft\(\);/);
});
