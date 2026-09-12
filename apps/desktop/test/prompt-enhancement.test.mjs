import { readComposerSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, main, protocol, runtime, oneShot, en, zh] = await Promise.all([
  readComposerSource(),
  read("../src/lib/api.ts"),
  readMainSource(),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/prompt-enhancement.ts"),
  read("../../../packages/agent-runtime/src/one-shot-complete.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("prompt enhancement uses the typed main-process bridge", () => {
  assert.match(protocol, /promptEnhance: "pi-desktop\/prompt\/enhance"/);
  assert.match(api, /enhancePrompt: \(req: PromptEnhancementRequest\)/);
  assert.match(api, /IPC\.invoke\.promptEnhance/);
  assert.match(main, /handle\(IPC\.invoke\.promptEnhance/);
  assert.match(main, /enhancePromptDraft\(/);
  assert.match(main, /sessionId: launchSessionId/);
  assert.match(main, /resolveAuth: \(\) => vendorOAuth\.resolveAuth/);
  assert.match(runtime, /completeOneShot\(/);
  assert.match(oneShot, /createProviderRetryStream/);
  assert.match(oneShot, /models\.streamSimple/);
  assert.match(oneShot, /withOpenCodeSessionHeaders/);
});

test("Composer enables enhancement with inline file references and guards stale results", () => {
  assert.match(composer, /const \[enhancingPrompt, setEnhancingPrompt\]/);
  assert.match(composer, /textToEnhance\.trim\(\)\.startsWith\("\/"\)/);
  assert.match(composer, /stripInlineComposerFileReferenceTokens/);
  assert.match(composer, /restoreInlineComposerFileReferenceTokens/);
  assert.match(composer, /!modelReady/);
  assert.match(
    composer,
    /className=\{`icon-btn composer-enhance-btn/,
  );
  assert.match(composer, /aria-busy=\{enhancingPrompt\}/);
  assert.match(composer, /className="tool-spinner"/);
  assert.match(composer, /IconUndo2/);
  assert.match(composer, /setEnhancementUndoText\(sourceText\)/);
  assert.match(composer, /enhancementVersionRef\.current !== sourceVersion/);
  assert.match(composer, /currentKey !== sourceKey/);
  assert.match(composer, /invalidatePromptEnhancement\(\);/);
  assert.match(composer, /className="composer-enhancement-error"/);
  assert.match(composer, /enhancementError\.code/);
  assert.match(composer, /setEnhancementError\(null\)/);
  assert.doesNotMatch(composer, /activeInlineFileReferences\.length > 0/);
});

test("prompt enhancement has complete English-first locale coverage", () => {
  for (const source of [en, zh]) {
    assert.match(source, /enhancePrompt:/);
    assert.match(source, /enhancingPrompt:/);
    assert.match(source, /undoEnhancement:/);
    assert.match(source, /enhancementFailed:/);
    assert.match(source, /dismissEnhancementError:/);
  }
});
