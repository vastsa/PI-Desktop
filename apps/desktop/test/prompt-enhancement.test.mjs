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
    /className=\{`icon-btn icon-btn-square composer-enhance-btn/,
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

test("prompt-enhancement settings expose templates, restore, and the draft variable", async () => {
  const card = await read("../src/features/settings/prompt-enhancement-card.tsx");
  const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
  const shared = await read("../../../packages/shared/src/prompt-enhancement.ts");
  const hostCore = await read("../../../crates/host-core/src/rpc/mod.rs");

  // The card is reachable from the AI settings tab.
  assert.match(settingsPage, /PromptEnhancementCard/);
  assert.match(card, /PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT/);
  assert.match(card, /PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE/);
  assert.match(card, /promptEnhancementSystemPrompt/);
  assert.match(card, /promptEnhancementUserTemplate/);
  assert.match(card, /promptEnhancementProviderId/);
  assert.match(card, /promptEnhancementModelId/);
  // A save that would drop the draft variable is refused before it is sent.
  assert.match(card, /templateMissingVariable/);
  assert.match(card, /isValidPromptEnhancementUserTemplate/);

  // The defaults live in shared so the settings page can display the same text
  // the runtime sends, and the placeholder is substituted literally.
  assert.match(shared, /export const PROMPT_ENHANCEMENT_DRAFT_VARIABLE/);
  assert.match(shared, /renderPromptEnhancementUserPrompt/);
  assert.match(shared, /resolvePromptEnhancementTemplates/);
  assert.doesNotMatch(shared, /\.replace\(PROMPT_ENHANCEMENT_DRAFT_VARIABLE, draft\)/);

  // host-core validates before persisting, so no other writer can store a
  // template that would silently drop the draft.
  assert.match(hostCore, /fn prompt_enhancement_template_error/);
  assert.match(hostCore, /MAX_PROMPT_ENHANCEMENT_TEMPLATE_CHARS/);
  assert.match(hostCore, /promptEnhancementUserTemplate must contain/);

  // The one-shot keeps its boundary: no history, no tools.
  assert.match(runtime, /promptEnhancementContext/);
  assert.match(oneShot, /createProviderRetryStream/);
});

test("prompt-enhancement locale coverage includes the settings copy", () => {
  for (const source of [en, zh]) {
    for (const key of [
      "promptEnhancementTitle",
      "promptEnhancementModel",
      "promptEnhancementSystemPrompt",
      "promptEnhancementUserTemplate",
      "promptEnhancementInsertDraft",
      "promptEnhancementRestoreAll",
      "promptEnhancementMissingDraftVariable",
      "promptEnhancementSaveError",
    ]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  }
});
