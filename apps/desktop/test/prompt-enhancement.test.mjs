import { readComposerSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROMPT_ENHANCEMENT_TIMEOUT_MS,
  withPromptEnhancementTimeout,
} from "../electron/main/prompt-enhancement-timeout.ts";

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
  assert.match(main, /withPromptEnhancementTimeout/);
  assert.match(main, /enhancementThinkingLevel \|\| "off"/);
  assert.match(main, /from "\.\.\/prompt-enhancement-timeout"/);
  assert.match(main, /withPromptEnhancementTimeout\(\(signal\) =>/);
  assert.match(main, /signal,/);
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
    assert.match(source, /enhancementTimeout:/);
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
  assert.match(card, /PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE/);
  assert.match(card, /promptEnhancementUserTemplate/);
  // The system prompt is not overridable; the card must not offer a field for it.
  assert.doesNotMatch(card, /promptEnhancementSystemPrompt/);
  // Editing happens in a sheet, opened from the card, matching the subagent editor.
  assert.match(card, /ext-sheet-overlay/);
  assert.match(card, /ext-sheet-actions/);
  assert.match(card, /portalOverlay/);
  assert.match(card, /promptEnhancementCustomTemplate/);
  // No switch — the edit button is the only control on the row; saving a
  // non-empty template activates it, restoring default deactivates.
  assert.doesNotMatch(card, /settings-toggle/);
  assert.doesNotMatch(card, /role="switch"/);
  assert.match(card, /hasCustomTemplate/);
  assert.match(card, /promptEnhancementCustomTemplateActive/);
  assert.match(card, /promptEnhancementCustomTemplate: Boolean/);
  assert.match(card, /settings-icon-button/);
  assert.match(card, /IconPencil/);
  assert.match(card, /EnhancementModelCard/);
  // Model and reasoning rows are composed in, not inlined on this file.
  assert.doesNotMatch(card, /promptEnhancementProviderId/);
  assert.doesNotMatch(card, /promptEnhancementThinkingLevel/);
  assert.doesNotMatch(card, /promptEnhancementModelId/);
  assert.doesNotMatch(card, /SubagentModelPicker/);
  // A save that would drop the draft variable or exceed the host-core bound
  // is refused before it is sent.
  assert.match(card, /templateMissingVariable/);
  assert.match(card, /templateTooLong/);
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
      "promptEnhancementEdit",
      "promptEnhancementUserTemplate",
      "promptEnhancementInsertDraft",
      "promptEnhancementCustomTemplate",
      "promptEnhancementCustomTemplateDesc",
      "promptEnhancementCustomTemplateNeedsTemplate",
      "promptEnhancementMissingDraftVariable",
      "promptEnhancementTooLong",
      "promptEnhancementSaveError",
    ]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  }
});

test("an enhancement request is released when the provider never answers", async () => {
  const started = Date.now();
  // A promise that never settles is exactly the hang the transport cannot bound
  // on its own: the abort signal is only consulted between provider retries.
  const never = new Promise(() => {});
  let seenSignal;
  await assert.rejects(
    withPromptEnhancementTimeout((signal) => {
      seenSignal = signal;
      return never;
    }, 40),
    (error) => {
      assert.equal(error.errorCode, "TIMEOUT");
      assert.match(error.message, /timed out after/);
      return true;
    },
  );
  assert.equal(seenSignal?.aborted, true, "timeout must abort the in-flight request");
  assert.ok(Date.now() - started < 2000, "the caller must be released promptly");
});

test("a completed enhancement is not turned into a timeout", async () => {
  assert.equal(
    await withPromptEnhancementTimeout(() => Promise.resolve("ok"), 5000),
    "ok",
  );
  await assert.rejects(
    withPromptEnhancementTimeout(() => Promise.reject(new Error("provider 500")), 5000),
    /provider 500/,
  );
});

test("the default ceiling is about a minute", () => {
  assert.equal(PROMPT_ENHANCEMENT_TIMEOUT_MS, 60_000);
});

test("the enhancement model and reasoning are rows on the Prompt enhancement card", async () => {
  const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
  const promptCard = await read("../src/features/settings/prompt-enhancement-card.tsx");
  const modelPage = await read("../src/components/settings/ModelConfigPage.tsx");
  const search = await read("../src/lib/settings-search.ts");
  const card = await read("../src/components/settings/EnhancementModelCard.tsx");

  const aiStart = settingsPage.indexOf('{tab === "ai" && settings && (');
  const shortcutsStart = settingsPage.indexOf('{tab === "shortcuts" && settings && (');
  const aiSource = settingsPage.slice(aiStart, shortcutsStart);
  assert.match(aiSource, /PromptEnhancementCard/);
  assert.doesNotMatch(aiSource, /EnhancementModelCard/);
  assert.match(promptCard, /EnhancementModelCard/);
  assert.doesNotMatch(modelPage, /EnhancementModelCard/);
  assert.doesNotMatch(modelPage, /promptEnhancementProviderId/);

  const aiSearch = search.slice(search.indexOf('id: "ai"'), search.indexOf('id: "shortcuts"'));
  const agentSearch = search.slice(search.indexOf('id: "agent"'), search.indexOf('id: "skills"'));
  assert.match(aiSearch, /promptEnhancementTitle/);
  assert.match(aiSearch, /promptEnhancementModelTitle/);
  assert.match(aiSearch, /promptEnhancementThinking/);
  assert.doesNotMatch(agentSearch, /promptEnhancementModelTitle/);
  assert.doesNotMatch(agentSearch, /promptEnhancementThinking/);

  assert.doesNotMatch(card, /promptEnhancementModelTitle/);
  assert.doesNotMatch(card, /SettingsCard/);
  assert.match(card, /t\("settings\.promptEnhancementModel"\)/);

  // Same control as the default-model row: one anchored menu, one search field.
  assert.match(card, /AnchoredMenu/);
  assert.match(card, /model-default-anchor/);
  assert.match(card, /promptEnhancementProviderId/);
  assert.match(card, /promptEnhancementModelId/);
  assert.match(card, /promptEnhancementModelFollow/);
  assert.match(card, /promptEnhancementModelUnavailable/);
  assert.match(card, /pickModel/);

  assert.match(card, /SettingsRow/);
});

test("the reasoning row follows the selected model's real ladder", async () => {
  const card = await read("../src/components/settings/EnhancementModelCard.tsx");

  // Reuse the Composer's model-aware resolution instead of the canonical list.
  assert.match(card, /thinkingProviderForModel/);
  assert.match(card, /thinkingLevelForProvider/);
  assert.match(card, /reasoningProvider/);
  assert.match(card, /levelOptions/);
  // A pinned model without reasoning still lists `off` and disables the row.
  assert.match(card, /noReasoning/);
  assert.match(card, /disabled=\{noReasoning\}/);
  // Switching model re-clamps the stored level onto the new model.
  const pickModel = card.slice(card.indexOf("const pickModel"), card.indexOf("return ("));
  assert.match(pickModel, /thinkingLevelForProvider\(nextProvider, stored\)/);
  // No follow-the-session option in this row.
  assert.doesNotMatch(card, /promptEnhancementThinkingFollow/);
});

test("the enhancement-model copy exists in both reference locales", () => {
  for (const source of [en, zh]) {
    for (const key of [
      "promptEnhancementModelTitle",
      "promptEnhancementModel",
      "promptEnhancementModelFollow",
      "promptEnhancementModelUnavailable",
      "promptEnhancementThinking",
      "promptEnhancementThinkingDesc",
      "promptEnhancementThinkingOff",
    ]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  }
});
