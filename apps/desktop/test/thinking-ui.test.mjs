import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/components/ChatSurface.tsx", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
// Agent/Plan mode and model selection are owned by the Composer; the
// conversation top bar only hosts the task title and window actions.
const topbarSource = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);
// Provider thinking config lives in the provider settings components, not the
// settings page shell.
const settingsSource = (
  await Promise.all(
    [
      "../src/components/settings/ModelConfigPage.tsx",
      "../src/components/settings/ProviderSetupDialog.tsx",
      "../src/components/settings/useProviderModels.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  )
).join("\n");
const stylesSource = await loadStyles();

test("composer exposes the runtime thinking level order and provider filtering", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.match(composerSource, new RegExp(`"${level}"`));
  }
  assert.match(composerSource, /supportedThinkingLevels/);
  assert.match(composerSource, /supportsReasoning/);
  assert.match(composerSource, /thinkingLevelForProvider/);
  assert.match(composerSource, /thinkingLevel:\s*level/);
  assert.match(composerSource, /composer-thinking-list/);
  assert.doesNotMatch(stylesSource, /\.composer-thinking-levels/);
  assert.doesNotMatch(stylesSource, /\.composer-thinking-level\b/);
  assert.match(
    stylesSource,
    /\.composer-model-thinking-menu\s*\{[\s\S]*?width:\s*min\(300px,\s*calc\(100vw - 24px\)\);/,
  );
  assert.match(composerSource, /availableThinkingLevels/);
  assert.match(composerSource, /thinkingMenuLevels/);
});

test("Composer owns the mode and model controls", () => {
  const leftToolbar = composerSource.slice(
    composerSource.indexOf('<div className="composer-left">'),
    composerSource.indexOf('<div className="composer-right">'),
  );
  const modeControl = leftToolbar.indexOf(
    'className="icon-btn mode-chip composer-mode-chip"',
  );
  const permissionControl = leftToolbar.indexOf('className="composer-permission"');
  const rightToolbar = composerSource.slice(
    composerSource.indexOf('<div className="composer-right">'),
    composerSource.indexOf('<div className="composer-right">') + 12000,
  );

  assert.ok(modeControl >= 0);
  assert.ok(permissionControl > modeControl);
  assert.doesNotMatch(leftToolbar, /composer-thinking|thinking-chip/);
  assert.doesNotMatch(topbarSource, /ModelSelect|model-chip/);
  assert.doesNotMatch(topbarSource, /ct-mode|ct-mode-btn|configureActiveSession/);
  assert.doesNotMatch(stylesSource, /\.conversation-topbar \.ct-mode/);
  assert.match(rightToolbar, /composer-model-thinking-chip/);
  assert.match(rightToolbar, /composer-model-thinking-menu/);
  assert.match(rightToolbar, /composer-menu-entry/);
  assert.match(rightToolbar, /composer-menu-back/);
});

test("conversation topbar keeps the title and actions free of a running indicator", () => {
  assert.doesNotMatch(topbarSource, /IconFolder|IconChevronRight/);
  assert.doesNotMatch(topbarSource, /className="ct-project"/);
  assert.doesNotMatch(topbarSource, /className="ct-title-chevron"/);
  assert.match(topbarSource, /className="ct-title"/);
  assert.doesNotMatch(topbarSource, /runningSessions|const isRunning|ct-running|role="status"/);
  assert.match(stylesSource, /\.conversation-topbar \.ct-title-wrap[\s\S]*?align-items: center/);
  assert.match(
    stylesSource,
    /\.conversation-topbar \.ct-title[\s\S]*?font-size: var\(--text-base\)/,
  );
  assert.doesNotMatch(stylesSource, /\.conversation-topbar \.ct-running(?:-dot)?\b/);
});

test("model menus do not expose desktop-owned reasoning overrides", () => {
  assert.doesNotMatch(composerSource, /canEnableThinkingOverride/);
  assert.doesNotMatch(composerSource, /chat\.thinkingEnable/);
  assert.doesNotMatch(composerSource, /supportsReasoning:\s*true/);
});

test("switching to a provider without reasoning resets the session level", () => {
  assert.match(
    composerSource,
    /if\s*\(!provider\?\.supportsReasoning\)\s*return\s*"off"/,
  );
  // Composer owns both the reasoning-level guard and its session write.
  assert.match(
    composerSource,
    /const thinkingLevel = thinkingLevelForProvider\(\s*thinkingProvider,\s*configuredThinkingLevel,\s*\)/,
  );
  assert.match(composerSource, /thinkingLevel:\s*level/);
});

test("draft Composer thinking follows the exact model selected in its menu", () => {
  assert.match(
    composerSource,
    /const providerModels = useAppStore\(\(s\) => s\.providerModels\)/,
  );
  assert.match(composerSource, /thinkingProviderForModel\(/);
  assert.match(
    composerSource,
    /const selectedModelCatalog = provider \? providerModels\[provider\.id\]/,
  );
  assert.match(composerSource, /const catalogThinkingProvider = thinkingProviderForModel\(/);
  assert.match(
    composerSource,
    /const nextModelProvider = thinkingProviderForModel\([\s\S]*?providerModels\[candidate\.id\]/,
  );
  assert.match(
    composerSource,
    /const nextThinkingLevel = activeSession[\s\S]*?thinkingLevelForProvider\(nextModelProvider, thinkingLevel\)[\s\S]*?highestSupportedThinkingLevel\(nextModelProvider\.supportedThinkingLevels\)/,
  );
});

test("new sessions default to the strongest level of a reasoning model", () => {
  const materializeSource =
    storeSource.match(
      /async function persistSessionAndSelect[\s\S]*?\n  return sessionId;\n}\n/,
    )?.[0] ?? "";
  assert.ok(
    materializeSource.length > 0,
    "materializeDraftSession implementation not found",
  );
  assert.match(materializeSource, /defaultProvider\?\.supportsReasoning/);
  assert.match(materializeSource, /highestSupportedThinkingLevel\(/);
  assert.match(
    materializeSource,
    /thinkingLevel:[\s\S]*?defaultThinkingLevel/,
  );
});

test("main resolves reasoning from each session's exact selected model", () => {
  assert.match(mainSource, /function enrichSession/);
  assert.match(mainSource, /modelsDevModelFor\(provider, session\.modelId\)/);
  assert.match(mainSource, /sessions:\s*result\.sessions\.map/);
  assert.match(mainSource, /modelConfigFromModelsDev\(modelsDevModel, provider\.baseUrl\)/);
  // models.dev records stamp reasoning capability per exact model id.
  assert.match(mainSource, /capabilitiesFromModelConfig\(modelConfig\)/);
  assert.match(mainSource, /supportsReasoning/);
  assert.doesNotMatch(mainSource, /resolvePiModelConfig/);
});

test("transcript keeps assistant thinking in a separate disclosure", () => {
  assert.match(transcriptSource, /tool-row thinking/);
  assert.match(transcriptSource, /className="tool-row-header"/);
  assert.match(transcriptSource, /aria-expanded=\{open\}/);
  assert.match(transcriptSource, /aria-hidden=\{!open\}/);
  assert.match(transcriptSource, /inert=\{!open\}/);
  assert.match(transcriptSource, /IconSparkles/);
  assert.match(transcriptSource, /messageThinking as thinkingText/);
  assert.match(transcriptSource, /thinking-prose[\s\S]*?Markdown source=\{text\}/);
  assert.match(transcriptSource, /CopyButton text=\{content\}/);
  assert.match(transcriptSource, /messageThinking as thinkingText/);
  assert.match(transcriptSource, /onlyThinking = items\.every/);
  assert.match(stylesSource, /\.thinking-prose/);
});

test("expanded assistant activity rails collapse their disclosures", () => {
  assert.match(
    transcriptSource,
    /function DisclosureCollapseRail\([\s\S]*?className="disclosure-collapse-rail"[\s\S]*?aria-label=\{label\}[\s\S]*?onClick=\{onCollapse\}/,
  );
  assert.match(
    transcriptSource,
    /className="tool-row-body"[\s\S]*?<DisclosureCollapseRail[\s\S]*?onCollapse=\{\(\) => setOpen\(false\)\}/,
  );
  assert.match(
    transcriptSource,
    /className="tool-activity-body"[\s\S]*?<DisclosureCollapseRail[\s\S]*?onCollapse=\{\(\) => setOpen\(false\)\}/,
  );
  assert.match(
    stylesSource,
    /\.disclosure-collapse-rail\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*16px;[\s\S]*?cursor:\s*pointer;/,
  );
  assert.match(stylesSource, /\.disclosure-collapse-rail:focus-visible\s*\{/);
});

test("thinking-only assistant streams open the transcript surface", () => {
  assert.match(appSource, /typeof message\.thinking === "string"/);
  assert.match(appSource, /hasContent \|\| hasThinking/);
});

test("provider settings persist model-local limits and thinking configuration", () => {
  assert.match(settingsSource, /useProviderModels/);
  assert.match(settingsSource, /bindingFromModelInfo/);
  assert.match(settingsSource, /levelChoices\.map/);
  assert.match(settingsSource, /supportedThinkingLevels/);
  assert.match(settingsSource, /contextWindow/);
  assert.match(settingsSource, /maxTokens/);
  assert.match(settingsSource, /defaultThinkingLevel/);
  assert.match(settingsSource, /models/);
});

test("main forwards the complete models.dev model record to the sidecar", () => {
  assert.match(mainSource, /modelConfigFromModelsDev/);
  assert.doesNotMatch(mainSource, /resolvePiModelConfig/);
  assert.match(mainSource, /\.\.\.\(modelConfig \? \{ modelConfig \} : \{\}\)/);
  assert.doesNotMatch(mainSource, /modelCompat/);
});

test("settings offers exactly the thinking levels the composer can render", () => {
  // The Composer renders the published levels a model exposes, so the dialog
  // must not offer the full canonical ladder: a level enabled here but dropped
  // by the runtime made the two counts disagree.
  assert.match(settingsSource, /publishedThinkingLevels/);
  assert.doesNotMatch(settingsSource, /THINKING_LEVELS\.map/);
  assert.match(
    settingsSource,
    /publishedLevelsById[\s\S]*?publishedThinkingLevels\(row\.info\)/,
  );
  assert.match(settingsSource, /settings\.thinkingDisabledHint/);
  // Stored bindings are narrowed to the published set before they are saved.
  assert.match(
    settingsSource,
    /bindingsToPersist[\s\S]*?const thinkingLevels = binding\.thinkingLevels\.filter/,
  );
  assert.match(settingsSource, /models: persisted/);
  // A row the catalog does not describe stays out of the published map, so an
  // offline endpoint or a hand-typed id cannot erase stored levels.
  assert.match(settingsSource, /if \(!row\.info\) continue;/);
  assert.match(
    settingsSource,
    /publishedLevelsById\.get\(binding\.id\.toLowerCase\(\)\) \?\?\s*\n?\s*binding\.thinkingLevels/,
  );
  assert.match(settingsSource, /if \(!choices\) return binding;/);
});
