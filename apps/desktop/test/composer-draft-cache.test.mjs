import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composer = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

test("composer keeps draft text and file references in a renderer-lifetime cache", () => {
  assert.match(composer, /const HOME_DRAFT_KEY = "__home__"/);
  assert.match(
    composer,
    /const composerDraftCache = new Map<string, ComposerDraftSnapshot>\(\);[\s\S]*export function Composer/,
  );
  assert.doesNotMatch(composer, /draftCacheRef|useRef\(new Map<string, ComposerDraftSnapshot>/);
  assert.match(composer, /function draftKeyForSession\(sessionId: string \| null \| undefined\)/);
  assert.match(composer, /const previousKey = draftKeyRef\.current/);
  assert.match(composer, /composerDraftCache\.set\(previousKey, \{[\s\S]*?fileReferences:/);
  assert.match(composer, /const nextDraft = composerDraftCache\.get\(draftKey\)/);
  assert.match(composer, /setValue\(nextDraft\?\.text \?\? ""\)/);
  assert.match(composer, /setFileReferences\([\s\S]*?createFileReference\(/);
});

test("composer restores on initial mount and snapshots live refs on unmount", () => {
  assert.match(
    composer,
    /useState\(\s*\(\) => composerDraftCache\.get\(draftKeyForSession\(activeSessionId\)\)\?\.text \?\? ""/,
  );
  assert.match(
    composer,
    /useState<ComposerFileReference\[]>\(\(\) =>\s*composerDraftCache[\s\S]*?\.fileReferences\.map\(\(fileReference\) =>[\s\S]*?createFileReference\(/,
  );
  const unmountSnapshot = composer.match(
    /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?composerDraftCache\.set\(key, \{[\s\S]*?\n\s*\},\s*\[\],\s*\);/,
  )?.[0] ?? "";
  assert.ok(unmountSnapshot, "unmount cleanup snapshots the active draft");
  assert.match(unmountSnapshot, /text: valueRef\.current/);
  assert.match(unmountSnapshot, /fileReferencesRef\.current/);
  assert.doesNotMatch(unmountSnapshot, /\[value|\[fileReferences/);
});

test("composer handles home drafts, deleted sessions, and async sends by key", () => {
  assert.match(composer, /key !== HOME_DRAFT_KEY && key !== draftKey && !sessionIds\.has\(key\)/);
  assert.match(composer, /const clearDraftForKey = \(key: string\)/);
  assert.match(composer, /draftKeyForSession\(useAppStore\.getState\(\)\.activeSessionId\)/);
  assert.match(composer, /const submittedDraftKey = draftKey/);
  assert.match(composer, /clearDraftForKey\(submittedDraftKey\)/);
  assert.doesNotMatch(composer, /if \(accepted\) clearDraft\(\);/);
});

test("an async clear cannot be overwritten by a late switch or unmount snapshot", () => {
  assert.match(composer, /const composerDraftVersions = new Map<string, number>\(\)/);
  assert.match(composer, /function invalidateComposerDraft\(key: string\)/);
  assert.match(
    composer,
    /draftVersionRef\.current === composerDraftVersion\(previousKey\)/,
  );
  assert.match(
    composer,
    /if \(draftVersionRef\.current !== composerDraftVersion\(key\)\) return;/,
  );
  assert.match(composer, /const nextVersion = invalidateComposerDraft\(key\)/);
});

test("home submission migrates its draft before sending the materialized session", () => {
  const send = composer.match(
    /const sendComposerPrompt = async[\s\S]*?\n  };\n\n  const enhancePrompt/,
  )?.[0] ?? "";
  assert.ok(send, "the composer must own one keyed prompt submission path");
  assert.match(send, /const materializedSessionId = await materializeDraftSession\(\)/);
  assert.match(send, /composerDraftCache\.set\(materializedSessionId, snapshot\)/);
  assert.match(send, /invalidateComposerDraft\(HOME_DRAFT_KEY\)/);
  assert.match(send, /sendPrompt\(content, snapshot, sessionId\)/);
  assert.match(send, /if \(accepted\) clearDraftForKey\(submittedKey\)/);
});
