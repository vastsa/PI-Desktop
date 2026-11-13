import {
  readSettingsSource,
  readPluginsSource,
  readMainSource,
  readSharedTypesSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsPageSource = await readSettingsSource();
const settingsSearchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const providersSource = await readFile(
  new URL("../src/components/settings/ModelConfigPage.tsx", import.meta.url),
  "utf8",
);
const defaultModelSource = await readFile(
  new URL("../src/components/settings/default-model.ts", import.meta.url),
  "utf8",
);
const scheduledSource = await readFile(
  new URL("../src/pages/ScheduledPage.tsx", import.meta.url),
  "utf8",
);
const scheduledFormatSource = await readFile(
  new URL("../src/features/scheduled/scheduled-format.ts", import.meta.url),
  "utf8",
);
const pluginsPageSource = await readPluginsSource();
// API services and vendor accounts share one list (D625).
const serviceListSource = await readFile(
  new URL("../src/components/settings/ServiceList.tsx", import.meta.url),
  "utf8",
);
const serviceRowSource = await readFile(
  new URL("../src/components/settings/ServiceRow.tsx", import.meta.url),
  "utf8",
);
const serviceRowStatusSource = await readFile(
  new URL("../src/components/settings/service-row-status.ts", import.meta.url),
  "utf8",
);
// Account lifecycle (remove with default repair, save) lives in the hook.
const vendorAccountsHookSource = await readFile(
  new URL("../src/components/settings/useVendorAccounts.ts", import.meta.url),
  "utf8",
);
const vendorAccountDialogSource = await readFile(
  new URL("../src/components/settings/VendorAccountDialog.tsx", import.meta.url),
  "utf8",
);
// Subscriptions are picked in the service chooser since D625.
const serviceChooserSource = await readFile(
  new URL("../src/components/settings/ServiceChooser.tsx", import.meta.url),
  "utf8",
);
const oauthSource = await readFile(
  new URL("../electron/main/oauth.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const languageSource = await readFile(
  new URL("../src/lib/app-language.ts", import.meta.url),
  "utf8",
);
const rendererLanguageSource = await readFile(
  new URL("../src/lib/renderer-language.ts", import.meta.url),
  "utf8",
);
const enLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const zhLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const trLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/tr/index.ts", import.meta.url),
  "utf8",
);
const zhTWLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-TW/index.ts", import.meta.url),
  "utf8",
);
const koLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/ko/index.ts", import.meta.url),
  "utf8",
);
const ptBRLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/pt-BR/index.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../src/main.tsx", import.meta.url),
  "utf8",
);
const electronMainSource = await readMainSource();
const preloadSource = await readFile(
  new URL("../electron/preload/index.ts", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readSharedTypesSource();
const stylesSource = await loadStyles();
const networkProxySource = await readFile(
  new URL("../src/components/settings/NetworkProxySection.tsx", import.meta.url),
  "utf8",
);
const voiceSettingsSource = await readFile(
  new URL("../src/features/settings/voice/VoiceSettingsSection.tsx", import.meta.url),
  "utf8",
);

/**
 * One destination, one subject (D684). The settings source contract is the
 * facade plus every file under features/settings, each chunk introduced by a
 * path comment, so a destination page is addressed by its file rather than by
 * a `tab === "…"` branch in the shell.
 */
function destinationSource(file) {
  const marker = `/* features/settings/pages/${file} */`;
  const start = settingsPageSource.indexOf(marker);
  assert.notEqual(start, -1, `${file} is not part of the settings source contract`);
  const next = settingsPageSource.indexOf("\n/* features/settings/", start + marker.length);
  return settingsPageSource.slice(start, next === -1 ? undefined : next);
}

test("settings destinations own one subject each", () => {
  const appearanceSource = destinationSource("AppearanceSettings.tsx");
  const conversationSource = destinationSource("ConversationSettings.tsx");
  const behaviorSource = destinationSource("AgentBehaviorSettings.tsx");
  const systemSource = destinationSource("SystemSettings.tsx");

  // Appearance is looks only: the machine-level cards moved to System.
  assert.match(appearanceSource, /<ThemeRow /);
  assert.match(appearanceSource, /<LanguageRow /);
  assert.match(appearanceSource, /<FontFamilyRow /);
  assert.match(appearanceSource, /<FontSizeRow /);
  assert.match(appearanceSource, /<RadialMenuSettings\b/);
  assert.match(appearanceSource, /<StartupAnimationRows\b/);
  assert.doesNotMatch(appearanceSource, /<NetworkProxySection /);
  assert.doesNotMatch(appearanceSource, /<StorageSettingsSection\b/);
  assert.doesNotMatch(appearanceSource, /keepAwakeWhileRunning:/);
  assert.doesNotMatch(appearanceSource, /\(\["auto", "zh-CN", "en"\] as const\)/);
  assert.doesNotMatch(appearanceSource, /defaultMode: value/);
  assert.doesNotMatch(appearanceSource, /enterToSend: !settings\.enterToSend/);
  assert.doesNotMatch(appearanceSource, /settings\.defaultsTitle/);

  // System owns network, storage, power and the window's close behavior.
  assert.match(systemSource, /<NetworkProxySection /);
  assert.match(systemSource, /<StorageSettingsSection\b/);
  assert.match(systemSource, /keepAwakeWhileRunning: settings\.keepAwakeWhileRunning !== true/);
  assert.match(systemSource, /preventScreenSleep: !settings\.preventScreenSleep/);
  assert.match(systemSource, /platform !== "darwin" && <CloseBehaviorSection \/>/);

  // Conversation owns presentation and composer input, and says once that it
  // changes neither the model nor what it may do.
  assert.match(conversationSource, /settings\.chatDisplayCaption/);
  assert.match(conversationSource, /<ShowThinkingRow /);
  assert.match(conversationSource, /<TranscriptDisplayModeRow /);
  assert.match(conversationSource, /ContextUsageDisplayRow/);
  assert.match(conversationSource, /enterToSend: !settings\.enterToSend/);
  assert.match(conversationSource, /LargePasteThresholdRow/);
  assert.match(conversationSource, /<LinkOpenTargetRow /);
  assert.doesNotMatch(conversationSource, /defaultMode: value/);
  assert.doesNotMatch(conversationSource, /defaultPermissionMode/);

  // Agent behavior owns what a run starts with and what it may do.
  assert.match(behaviorSource, /defaultMode: value/);
  assert.match(behaviorSource, /settings\.sessionDefaults/);
  assert.match(behaviorSource, /settings\.execution/);
  assert.match(behaviorSource, /CommandShellRow/);
  // The Execution card renders the retry rows component, which owns the
  // infinite-retry toggle and the bounded retry fields.
  assert.match(settingsPageSource, /infiniteProviderRetry: settings\.infiniteProviderRetry !== true/);
  assert.match(behaviorSource, /scheduledTasksEnabled: settings\.scheduledTasksEnabled === false/);
  assert.match(behaviorSource, /<ComputerUseSettings\b/);
  assert.doesNotMatch(behaviorSource, /settings\.defaultsTitle/);
  assert.doesNotMatch(behaviorSource, /<ShowThinkingRow /);
  assert.doesNotMatch(behaviorSource, /enterToSend: !settings\.enterToSend/);

  assert.doesNotMatch(behaviorSource, /PromptEnhancementCard|promptEnhancement/);
  assert.doesNotMatch(behaviorSource, /EnhancementModelCard/);
  // The execution card keeps the retry rows (max attempts and delays) that the
  // provider-retry feature adds on top of the infinite-retry toggle.
  assert.match(
    behaviorSource,
    /<ProviderRetrySettingsRows settings=\{settings\} saveSettings=\{saveSettings\}/,
  );

  assert.match(
    settingsPageSource,
    /saveSettings\(\{ contextUsageDisplay: value \}\)/,
  );
  for (const key of [
    "settings.contextUsageDisplay",
    "settings.contextUsageDisplayRemaining",
    "settings.contextUsageDisplayUsed",
    "settings.infiniteProviderRetry",
    "settings.infiniteProviderRetryDesc",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replaceAll(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(trLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
  }
  assert.match(sharedTypesSource, /contextUsageDisplay\?: ContextUsageDisplay/);
  assert.match(sharedTypesSource, /infiniteProviderRetry\?: boolean/);
  assert.match(sharedTypesSource, /ContextUsageDisplay = "remaining" \| "used"/);
  assert.match(sharedTypesSource, /chatContentMaxWidth\?: number/);
  assert.match(settingsPageSource, /largePasteThreshold/);
  assert.match(settingsPageSource, /saveSettings\(\{ largePasteThreshold: next \}\)/);
  assert.doesNotMatch(settingsPageSource, /commandShellConfigured/);
  assert.match(
    behaviorSource,
    /defaultPermissionMode: mode as GlobalPermissionMode/,
  );
  assert.match(behaviorSource, /<SettingsMenuSelect\b/);
  assert.match(behaviorSource, /"accept-edits"/);
  // Behavior keeps the Settings picker control: a native <select> popup is
  // platform-drawn and cannot carry the shared menu surface or its check mark.
  assert.doesNotMatch(behaviorSource, /<select/);
  // Voice owns a separate destination; no other page duplicates it.
  assert.doesNotMatch(behaviorSource, /VoiceSettingsCard|VoiceSettingsSection|voice-settings/);
  assert.match(settingsPageSource, /tab === "voice" && !tabHidden && settings && [\s\S]*?<VoiceSettingsSection/);
  assert.match(voiceSettingsSource, /LiveVoiceSettings as VoiceSettingsSection/);
  assert.doesNotMatch(voiceSettingsSource, /voiceIpc|voiceEnable|voiceMicrophone|voiceModel/);
  assert.doesNotMatch(settingsSearchSource, /settings\.voiceEnable|settings\.voiceMicrophone|settings\.voiceModel/);
  assert.match(settingsSearchSource, /liveVoice\.enable/);
  assert.doesNotMatch(settingsSearchSource, /settings\.speech/);
  assert.doesNotMatch(stylesSource, /\.settings-speech/);
  assert.doesNotMatch(enLocaleSource, /speechTitle:|speechVoicePlaceholder:/);
  assert.match(protocolSource, /speechTranscribe: "pi-desktop\/speech\/transcribe"/);
});

test("language persists as part of shared app settings", () => {
  assert.match(
    sharedTypesSource,
    /language\?: "auto" \| "en" \| "zh-CN" \| "zh-TW" \| "tr" \| "de" \| "es" \| "fr" \| "ko"/,
  );
  assert.match(sharedTypesSource, /largePasteThreshold\?: number/);
  assert.match(sharedTypesSource, /fontScale\?: number/);
  assert.match(sharedTypesSource, /networkProxy\?: NetworkProxySettings/);
});

test("General Network card persists a custom HTTP or SOCKS5 proxy and the relaxed network mode", () => {
  assert.match(settingsPageSource, /<NetworkProxySection /);
  assert.match(networkProxySource, /settings\.networkRelaxedMode/);
  // A mode switch saves the current drafts, even when the input blur save has
  // not refreshed `saved` yet, so Custom restores the user's latest values.
  assert.match(
    networkProxySource,
    /settingsForInactiveProxyMode\(mode, saved, urlDraft, bypassDraft\)/,
  );
  assert.match(
    networkProxySource,
    /resolveCustomProxyUrl\(urlDraft, saved\.url\)/,
  );
  assert.match(networkProxySource, /url: resolved\.url/);
  // Fake-IP tolerance belongs to the network mode now, not to the proxy payload.
  assert.doesNotMatch(networkProxySource, /allowFakeIp/);
  assert.match(settingsSearchSource, /settings\.proxy/);
  assert.match(settingsSearchSource, /settings\.proxyCustom/);
  assert.match(settingsSearchSource, /settings\.networkRelaxedMode/);
  assert.match(electronMainSource, /applyNetworkProxyFromAppSettings/);
  assert.match(electronMainSource, /IPC\.invoke\.networkProxyTest/);
  assert.match(protocolSource, /networkProxyTest: "pi-desktop\/network\/testProxy"/);
  for (const source of [
    enLocaleSource,
    zhLocaleSource,
    zhTWLocaleSource,
    trLocaleSource,
    koLocaleSource,
  ]) {
    assert.match(source, /proxyCustom:/);
    assert.match(source, /proxyUrlPlaceholder:/);
    assert.match(source, /networkRelaxedMode:/);
    assert.match(source, /networkRelaxedModeDesc:/);
  }
});

test("basics gates developer tools behind a persisted developer mode", () => {
  assert.match(sharedTypesSource, /developerMode\?: boolean/);
  assert.match(settingsPageSource, /function DeveloperSection/);
  assert.match(settingsPageSource, /<SettingsToggle\s+checked=\{enabled\}/);
  assert.match(settingsPageSource, /saveSettings\(\{ developerMode: !enabled \}\)/);
  assert.match(settingsPageSource, /api\.toggleDevTools\(true\)/);
  assert.match(settingsPageSource, /disabled=\{!enabled\}/);
  for (const key of [
    "settings.developer",
    "settings.developerMode",
    "settings.devTools",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replace(".", "\\.")));
  }
});

test("stored language drives i18n and native labels at startup and on settings change", () => {
  assert.match(languageSource, /export function initLanguageSync/);
  assert.match(rendererLanguageSource, /changeLanguage/);
  assert.match(rendererLanguageSource, /resolveLocale/);
  assert.match(mainSource, /initLanguageSync\(\)/);
  assert.match(electronMainSource, /catalogs\[resolveLocale\(locale\)\]/);
});

test("date copy follows the active application locale", () => {
  // The page resolves one locale and hands it to every moment it renders; the
  // formatter is what actually builds the string.
  assert.match(scheduledSource, /const locale = i18n\.resolvedLanguage \?\? i18n\.language;/);
  assert.match(scheduledSource, /locale=\{locale\}/);
  assert.match(
    scheduledFormatSource,
    /new Intl\.DateTimeFormat\(locale \|\| undefined/,
  );
  assert.match(
    providersSource,
    /toLocaleString\(\s*i18n\.resolvedLanguage \?\? i18n\.language/s,
  );
});

test("sandboxed preload receives the OS locale without importing main-only APIs", () => {
  assert.match(electronMainSource, /additionalArguments:\s*\[`--pi-desktop-locale=\$\{app\.getLocale\(\)\}`\]/);
  assert.match(preloadSource, /const LOCALE_ARGUMENT_PREFIX = "--pi-desktop-locale="/);
  assert.match(preloadSource, /process\.argv[\s\S]*startsWith\(LOCALE_ARGUMENT_PREFIX\)/);
  assert.doesNotMatch(preloadSource, /import\s*\{[^}]*\bapp\b[^}]*\}\s*from "electron"/);
  assert.doesNotMatch(preloadSource, /locale:\s*app\.getLocale\(\)/);
});

test("model configuration keeps model defaults; AI owns app behavior defaults", () => {
  assert.match(providersSource, /settings\.defaultModel/);
  assert.doesNotMatch(providersSource, /enterToSend/);
  assert.doesNotMatch(providersSource, /settings\.modeAgent/);
  assert.doesNotMatch(providersSource, /EnhancementModelCard/);
});


test("model configuration lists AI services and vendor accounts together", () => {
  // One list (D625): nothing filters OAuth rows out, and no second section.
  assert.doesNotMatch(providersSource, /authKind !== OAUTH_AUTH_KIND/);
  assert.doesNotMatch(providersSource, /VendorAccountsSection/);
  assert.match(providersSource, /<ServiceList\s+providers=\{providers\}/);
  // Readiness (a key, an OAuth account, or a no-auth provider) now lives in the
  // shared helper, so the page must delegate to it instead of re-inlining the
  // rule next to a second copy that can drift from the picker.
  assert.match(providersSource, /providerServesChatModels\(/);
  assert.match(
    defaultModelSource,
    /provider\.hasSecret \|\| !!provider\.hasOauth \|\| provider\.authKind === "none"/,
  );
  assert.doesNotMatch(providersSource, /provider-config-hero/);
  assert.doesNotMatch(providersSource, /settings-section-subtitle/);
  // An account row still lives and dies through the vendor-account editor and
  // deleteOauthAccount, never through the provider CRUD.
  assert.match(
    providersSource,
    /serviceRowKind\(provider\) === "account"\s*\?\s*setEditingAccountId\(provider\.id\)\s*:\s*setSetupFor\(provider\.id\)/,
  );
  assert.match(
    providersSource,
    /serviceRowKind\(provider\) === "account"\s*\?\s*removeAccount\(provider\)\s*:\s*removeProvider\(provider\)/,
  );
  assert.match(providersSource, /<VendorAccountDialog/);
  assert.match(providersSource, /api\.testProvider\(provider\.id\)/);
  assert.match(vendorAccountsHookSource, /api\.deleteOauthAccount\(provider\.id\)/);
  assert.match(vendorAccountsHookSource, /api\.updateProvider\(/);
  assert.match(vendorAccountsHookSource, /oauthAccountLabel: form\.name\.trim\(\)/);
  assert.match(vendorAccountsHookSource, /defaultModelId: form\.modelId\.trim\(\)/);
  assert.match(vendorAccountsHookSource, /models: form\.models/);
  assert.doesNotMatch(stylesSource, /\.vendor-card-list/);
  assert.doesNotMatch(stylesSource, /vendor-account-row/);
  // Both credential kinds now pick from the same live, service-provided list.
  assert.match(vendorAccountDialogSource, /useProviderModels/);
  assert.match(vendorAccountDialogSource, /<ModelSelectionPanes/);
  assert.doesNotMatch(vendorAccountDialogSource, /<ChosenModelsSummary/);
  assert.match(vendorAccountDialogSource, /modelId: persisted\[0\]\.id/);
  assert.match(vendorAccountsHookSource, /providerIsReady/);
  assert.match(vendorAccountsHookSource, /defaultProviderId: next\?\.id \?\? ""/);
  assert.match(vendorAccountsHookSource, /useAppStore\.setState\(\{ settings: nextSettings \}\)/);
  assert.match(serviceChooserSource, /existing accounts do not disable a\s+vendor/);
  assert.match(serviceChooserSource, /vendors\.map/);
});

test("a service row opens its editor and keeps only a switch and one menu", () => {
  // The row is the way in; every other action sits in the overflow menu.
  assert.match(serviceRowSource, /<CapabilityRowMenu/);
  assert.doesNotMatch(serviceRowSource, /IconPencil|IconTrash|IconCopy|IconPlug|IconStar/);
  assert.match(serviceListSource, /IconPencil[\s\S]*IconTrash/);
  // The click sits on the row so a card drag can start anywhere on it, while
  // presses on the row's own controls never open the editor.
  assert.match(serviceRowSource, /const OWN_CONTROLS = "button, input, select, textarea, a, label/);
  assert.match(serviceRowSource, /event\.target !== event\.currentTarget \|\| !onOpen \|\| busy/);
  // An account has no enable switch; a plugin's switch belongs to the plugin.
  assert.match(serviceRowSource, /kind !== "account" \? \(/);
  assert.match(serviceRowSource, /disabled=\{busy \|\| kind === "plugin"\}/);
  // Plugin-owned rows are not editable, including OAuth account rows; those
  // rows still expose sign-out through the overflow menu.
  assert.match(serviceListSource, /const pluginOAuth = kind === "account" && !!provider\.ownerPluginId/);
  assert.match(
    serviceListSource,
    /if \(kind !== "plugin" && !pluginOAuth\) \{\s*items\.push\(\{\s*key: "edit"/,
  );
  assert.match(serviceListSource, /t\(pluginOAuth\s*\?\s*"settings\.vendorSignOut"/);
  assert.match(serviceListSource, /if \(kind !== "plugin"\) \{\s*const isArmed/);
  // Removal is confirmed inside the menu rather than by a second row button.
  assert.match(serviceListSource, /useArmedDelete\(\)/);
  assert.match(serviceListSource, /settings\.capabilityRemoveConfirm/);
  // D297: the plugin key entry is set apart by spacing, never by a rule.
  const keyEntry = stylesSource.match(/\.model-provider-key-entry\s*\{([^}]*)\}/)?.[1];
  assert.ok(keyEntry, ".model-provider-key-entry rule is missing");
  assert.doesNotMatch(keyEntry, /border/);
});

test("vendor account rows keep the summary to one account name", () => {
  // The account sits in the title beside its vendor; the meta line holds only
  // what service-row-status derives, never the default model id.
  assert.match(
    serviceRowSource,
    /<span className="model-provider-row-account">\{title\.account\}<\/span>/,
  );
  assert.doesNotMatch(serviceRowSource, /defaultModelId|font-mono/);
  assert.match(
    serviceRowStatusSource,
    /return provider\.hasOauth \? \[models\] : \[t\("settings\.vendorDisconnectedDesc"\)\]/,
  );
});

test("OAuth account identity is provider-scoped across IPC and pi-ai", () => {
  assert.match(protocolSource, /providersOauthDelete/);
  assert.doesNotMatch(protocolSource, /providersOauthLogout/);
  assert.match(oauthSource, /accountModels = new Map<string, AccountModels>/);
  assert.match(oauthSource, /fresh provider row/);
  assert.match(oauthSource, /secretRefForProviderOauth\(providerId\)/);
  assert.match(oauthSource, /deleteAccount\(providerId: string\)/);
});


test("settings nav icons map each destination to a semantic lucide glyph", () => {
  assert.match(settingsPageSource, /appearance: <IconPalette/);
  assert.match(settingsPageSource, /chat: <IconChat/);
  assert.match(settingsPageSource, /behavior: <IconSliders/);
  assert.match(settingsPageSource, /system: <IconMonitor/);
  assert.doesNotMatch(settingsPageSource, /usage: <IconActivity/);
  assert.match(settingsPageSource, /shortcuts: <IconKeyboard/);
  assert.match(settingsPageSource, /instructions: <IconFileText/);
  assert.match(settingsPageSource, /agent: <IconBot/);
  assert.doesNotMatch(settingsPageSource, /import: <IconDownload/);
  assert.match(settingsPageSource, /projects: <IconArchive/);
  assert.match(settingsPageSource, /about: <IconInfo/);
  assert.doesNotMatch(settingsPageSource, /general: <Icon/);
  assert.doesNotMatch(settingsPageSource, /ai: <Icon/);
  assert.doesNotMatch(settingsPageSource, /agent: <IconConfig/);
  assert.doesNotMatch(settingsPageSource, /import: <IconSnapshot/);
  // The page repeats the rail's glyph at page scale, so a destination is
  // recognised the same way in both places (D684).
  assert.match(settingsPageSource, /className="settings-page-icon"/);
  assert.match(settingsPageSource, /activeNavItem\?\.icon/);
});

test("settings nav keeps a flat searchable index with titled visual groups", () => {
  assert.match(settingsPageSource, /filteredGroups\.map/);
  assert.match(settingsPageSource, /className="settings-nav-group"/);
  assert.match(settingsPageSource, /SETTINGS_NAV_GROUP_LABELS/);
  assert.match(settingsPageSource, /className="settings-nav-group-label"/);
  assert.match(settingsSearchSource, /group: "preferences"/);
  assert.match(settingsSearchSource, /group: "agent"/);
  assert.match(settingsSearchSource, /group: "workspace"/);
  assert.match(settingsSearchSource, /group: "system"/);
  for (const key of [
    "settings.groupPreferences",
    "settings.groupAgent",
    "settings.groupWorkspace",
    "settings.groupSystem",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replace(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".")[1]}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".")[1]}:`));
    assert.match(zhTWLocaleSource, new RegExp(`${key.split(".")[1]}:`));
    assert.match(trLocaleSource, new RegExp(`${key.split(".")[1]}:`));
  }
  assert.doesNotMatch(settingsSearchSource, /id: "extensions"/);
  const navOrder = [
    "appearance",
    "chat",
    "shortcuts",
    "voice",
    "behavior",
    "agent",
    "instructions",
    "skills",
    "mcp",
    "subagents",
    "projects",
    "system",
    "sync",
    "remoteHosts",
    "about",
  ].map((id) => settingsSearchSource.indexOf(`id: "${id}"`));
  assert.ok(navOrder.every((index) => index >= 0));
  assert.deepEqual(navOrder, [...navOrder].sort((a, b) => a - b));
  // The destinations the D684 split retired keep no index entry of their own;
  // a stored or linked id resolves to its successor instead.
  assert.equal(settingsSearchSource.indexOf('id: "general"'), -1);
  assert.equal(settingsSearchSource.indexOf('id: "ai"'), -1);
  assert.equal(settingsSearchSource.indexOf('id: "usage"'), -1);
  assert.match(settingsSearchSource, /general: "appearance"/);
  assert.match(settingsSearchSource, /ai: "behavior"/);
  const entry = (id, next) =>
    settingsSearchSource.slice(
      settingsSearchSource.indexOf(`id: "${id}"`),
      settingsSearchSource.indexOf(`id: "${next}"`),
    );
  const appearanceEntry = entry("appearance", "chat");
  const chatEntry = entry("chat", "shortcuts");
  const behaviorEntry = entry("behavior", "agent");
  const systemEntry = entry("system", "sync");
  assert.doesNotMatch(settingsSearchSource, /settings\.defaultsTitle/);
  assert.match(appearanceEntry, /settings\.theme/);
  assert.match(appearanceEntry, /settings\.radialMenu/);
  assert.doesNotMatch(appearanceEntry, /settings\.proxy/);
  assert.doesNotMatch(appearanceEntry, /settings\.storage\.title/);
  assert.match(chatEntry, /settings\.transcriptDisplayMode/);
  assert.match(chatEntry, /settings\.enterToSend/);
  assert.match(behaviorEntry, /settings\.sessionDefaults/);
  assert.match(behaviorEntry, /settings\.commandShell/);
  assert.match(behaviorEntry, /settings\.permissionMode/);
  assert.match(systemEntry, /settings\.proxy/);
  assert.match(systemEntry, /settings\.storage\.title/);
  assert.match(systemEntry, /settings\.power/);
  assert.doesNotMatch(behaviorEntry, /settings\.promptEnhancementModelTitle/);
  assert.match(settingsSearchSource, /keywordKeys/);
  assert.match(settingsSearchSource, /settings\.projectArchive/);
  assert.doesNotMatch(stylesSource, /\.token-usage-page/);
  assert.match(stylesSource, /\.settings-nav-item\s*\{/);
  assert.match(stylesSource, /\.settings-nav-group-label\s*\{/);
  assert.doesNotMatch(stylesSource, /\.settings-nav-group \+ \.settings-nav-group/);
  assert.doesNotMatch(stylesSource, /\.settings-nav-group-label[^}]*border/);
  assert.match(
    stylesSource,
    /\.settings-row\.settings-row-plain\s*\{[^}]*border-bottom:\s*0/s,
  );
});

test("settings rail uses short parallel labels and descriptive page titles", () => {
  const navKeys = [
    "settings.nav.appearance",
    "settings.nav.chat",
    "settings.nav.behavior",
    "settings.nav.system",
    "settings.nav.shortcuts",
    "settings.nav.instructions",
    "settings.nav.models",
    "settings.nav.skills",
    "settings.nav.mcp",
    "settings.nav.subagents",
    "settings.nav.projects",
    "settings.nav.info",
  ];
  for (const key of navKeys) {
    assert.match(settingsSearchSource, new RegExp(key.replaceAll(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhTWLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(trLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
  }
  assert.match(settingsSearchSource, /titleKey: "settings\.configuration"/);
  assert.match(settingsSearchSource, /titleKey: "settings\.projectArchive"/);
  assert.match(settingsPageSource, /activeTitleKey/);
  assert.match(settingsPageSource, /titleKey: entry\.titleKey/);
  // A restructured destination also says in one line what it decides (D684);
  // a workbench that opens with its own description carries no subtitle.
  for (const key of [
    "settings.appearanceSubtitle",
    "settings.conversationSubtitle",
    "settings.agentBehaviorSubtitle",
    "settings.systemSubtitle",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replaceAll(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhTWLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(trLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
  }
  assert.match(settingsPageSource, /className="settings-page-subtitle"/);
  assert.match(settingsSearchSource, /id: "agent",[\s\S]*?keywordKeys/);
  assert.doesNotMatch(
    settingsSearchSource,
    /id: "agent",\s*labelKey[^}]*subtitleKey/,
  );
});

test("Plugins marketplace keeps official refresh without source settings", () => {
  assert.doesNotMatch(
    pluginsPageSource,
    /MarketplaceSourceSettings|pluginMarketSource|pluginMarketCustomUrl|marketProvider|marketCustomUrl|marketSource/,
  );
  assert.match(pluginsPageSource, /api\.marketRefresh\(true\)/);
  assert.match(pluginsPageSource, /refreshMarket\(query, \{ refreshRemote: true \}\)/);
  assert.doesNotMatch(settingsPageSource, /ExtensionMarketSection/);
  assert.doesNotMatch(settingsPageSource, /tab === "extensions"/);
});

test("settings compact pickers hug the current label on the shared menu select", () => {
  assert.match(
    stylesSource,
    /\.settings-language-anchor,\s*\.settings-theme-anchor,\s*\.settings-menu-select-anchor,\s*\.settings-font\s*\{[^}]*width:\s*max-content/s,
  );
  assert.match(
    stylesSource,
    /\.settings-language-trigger,\s*\.settings-theme-trigger,\s*\.settings-menu-select-trigger,\s*\.settings-font-trigger\s*\{[^}]*width:\s*max-content/s,
  );
});

test("native select menus keep readable theme colors across the app on Windows", () => {
  assert.match(
    stylesSource,
    /select option,\s*select optgroup\s*\{[^}]*background-color:\s*var\(--ds-bg-elevated-opaque\);[^}]*color:\s*var\(--ds-text-primary\);/s,
  );
  assert.match(stylesSource, /select\s*\{[^}]*color-scheme:\s*inherit;/s);
  assert.match(
    stylesSource,
    /:root,\s*:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;/s,
  );
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light;/s,
  );
});

test("Live Voice account cards show their options only after a provider is chosen", async () => {
  const source = await readFile(
    new URL("../src/features/settings/voice/LiveVoiceSettings.tsx", import.meta.url),
    "utf8",
  );
  // A card with no provider account bound is the picker and nothing else: the
  // model, voice, and protocol rows belong to a chosen binding instead of
  // rendering as empty disabled controls.
  assert.match(source, /\{current && adapter !== "codex-live" \? \(/);
  assert.match(source, /\{current && adapter === "openai-realtime" \? \(/);
  assert.doesNotMatch(source, /disabled=\{!current/);
});
