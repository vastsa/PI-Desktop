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
const pluginsPageSource = await readPluginsSource();
const marketplaceSettingsSource = await readFile(
  new URL(
    "../src/components/plugins/MarketplaceSourceSettings.tsx",
    import.meta.url,
  ),
  "utf8",
);
const vendorAccountsSource = await readFile(
  new URL("../src/components/settings/VendorAccountsSection.tsx", import.meta.url),
  "utf8",
);
const vendorAccountDialogSource = await readFile(
  new URL("../src/components/settings/VendorAccountDialog.tsx", import.meta.url),
  "utf8",
);
const vendorPickerSource = await readFile(
  new URL("../src/components/settings/VendorPickerDialog.tsx", import.meta.url),
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

test("Basics and AI tabs expose their respective app and AI controls", () => {
  const generalStart = settingsPageSource.indexOf('{tab === "general" && settings && (');
  const aiStart = settingsPageSource.indexOf('{tab === "ai" && settings && (');
  const shortcutsStart = settingsPageSource.indexOf(
    '{tab === "shortcuts" && settings && (',
  );
  const generalSource = settingsPageSource.slice(generalStart, aiStart);
  const voiceStart = settingsPageSource.indexOf('tab === "voice"', aiStart);
  assert.ok(voiceStart > aiStart && voiceStart < shortcutsStart);
  const aiSource = settingsPageSource.slice(aiStart, voiceStart);

  assert.match(generalSource, /<ThemeRow /);
  assert.match(generalSource, /<LanguageRow /);
  assert.match(generalSource, /<FontFamilyRow /);
  assert.match(generalSource, /<FontSizeRow /);
  assert.match(generalSource, /<NetworkProxySection /);
  assert.doesNotMatch(generalSource, /\(\["auto", "zh-CN", "en"\] as const\)/);
  assert.doesNotMatch(generalSource, /defaultMode: value/);
  assert.doesNotMatch(generalSource, /enterToSend: !settings\.enterToSend/);
  assert.doesNotMatch(generalSource, /settings\.defaultsTitle/);
  assert.match(aiSource, /defaultMode: value/);
  assert.match(aiSource, /settings\.defaultsTitle/);
  assert.match(aiSource, /CommandShellRow/);
  assert.match(aiSource, /enterToSend: !settings\.enterToSend/);
  assert.match(aiSource, /infiniteProviderRetry: settings\.infiniteProviderRetry !== true/);
  assert.match(aiSource, /LargePasteThresholdRow/);
  assert.match(aiSource, /ContextUsageDisplayRow/);
  assert.match(aiSource, /PromptEnhancementCard/);
  assert.doesNotMatch(aiSource, /EnhancementModelCard/);
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
    aiSource,
    /defaultPermissionMode: mode as GlobalPermissionMode/,
  );
  assert.match(aiSource, /<SettingsMenuSelect\b/);
  assert.match(aiSource, /"accept-edits"/);
  // The AI tab keeps the Settings picker control: a native <select> popup is
  // platform-drawn and cannot carry the shared menu surface or its check mark.
  assert.doesNotMatch(aiSource, /<select/);
  // The retired speech card stays out of AI settings; voice has its own tab.
  assert.doesNotMatch(aiSource, /VoiceSettingsCard|VoiceSettingsSection|voice-settings/);
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
  assert.match(settingsPageSource, /<SettingsToggle\s+checked=\{enabled\}\s+label=\{t\("settings\.developerMode"\)\}/);
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
  assert.match(languageSource, /changeLanguage/);
  assert.match(languageSource, /resolveLocale/);
  assert.match(mainSource, /initLanguageSync\(\)/);
  assert.match(electronMainSource, /catalogs\[resolveLocale\(locale\)\]/);
});

test("date copy follows the active application locale", () => {
  assert.match(
    scheduledSource,
    /toLocaleString\(\s*i18n\.resolvedLanguage \?\? i18n\.language/s,
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

test("default model selector shows every configured model under its provider", () => {
  const defaultModelPicker =
    providersSource.match(
      /visibleDefaultModelOptions\.map\(\(\{ provider, modelId \}, index\) => \{[\s\S]*?<\/li>/,
    )?.[0] ?? "";
  assert.notEqual(defaultModelPicker, "");
  assert.match(defaultModelPicker, /model-default-provider-group/);
  assert.match(defaultModelPicker, /model-default-option-model font-mono">[\s\S]*?\{modelId\}/);
  assert.match(defaultModelPicker, /setDefaultModel\(provider, modelId\)/);
  assert.match(providersSource, /settings-text-action model-default-trigger/);
  assert.doesNotMatch(providersSource, /defaultModelDescription/);
  // The accessible name follows the provider heading, which is the vendor
  // account's own label when it has one (#785).
  assert.match(
    providersSource,
    /aria-label=\{`\$\{providerDisplayName\(provider\)\} · \$\{modelId\}`\}/,
  );
  assert.match(providersSource, /placeholder=\{t\("settings\.defaultModelSearch"\)\}/);
  assert.match(providersSource, /model-default-results/);
  assert.match(stylesSource, /\.model-default-results\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(stylesSource, /scrollbar-gutter: stable/);
});

test("model configuration separates AI services from independently removable vendor accounts", () => {
  assert.match(providersSource, /authKind !== OAUTH_AUTH_KIND/);
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
  assert.match(vendorAccountsSource, /api\.deleteOauthAccount\(account\.providerId\)/);
  assert.match(vendorAccountsSource, /api\.updateProvider\(/);
  assert.match(vendorAccountsSource, /oauthAccountLabel: form\.name\.trim\(\)/);
  assert.match(vendorAccountsSource, /defaultModelId: form\.modelId\.trim\(\)/);
  assert.match(vendorAccountsSource, /models: form\.models/);
  assert.match(vendorAccountsSource, /api\.testProvider\(provider\.id\)/);
  assert.match(vendorAccountsSource, /VendorAccountDialog/);
  assert.match(
    vendorAccountsSource,
    /<Button\s+variant="primary"[\s\S]*vendorAddAccount/,
  );
  assert.doesNotMatch(vendorAccountsSource, /settings-section-subtitle/);
  assert.match(vendorAccountsSource, /settings-panel provider-list-panel/);
  assert.match(vendorAccountsSource, /provider-row-list/);
  assert.match(vendorAccountsSource, /"provider-row",\s*"vendor-account-row"/);
  assert.doesNotMatch(vendorAccountsSource, /vendor-card/);
  assert.match(stylesSource, /\.provider-row\.vendor-account-row\.is-disconnected/);
  assert.doesNotMatch(stylesSource, /\.vendor-card-list/);
  // Both credential kinds now pick from the same live, service-provided list.
  assert.match(vendorAccountDialogSource, /useProviderModels/);
  assert.match(vendorAccountDialogSource, /<ModelSelectionPanes/);
  assert.match(vendorAccountDialogSource, /modelId: persisted\[0\]\.id/);
  assert.match(vendorAccountsSource, /providerIsReady/);
  assert.match(vendorAccountsSource, /defaultProviderId: next\?\.id \?\? ""/);
  assert.match(vendorAccountsSource, /useAppStore\.setState\(\{ settings: nextSettings \}\)/);
  assert.match(vendorPickerSource, /existing accounts do not disable a vendor/);
  assert.match(vendorPickerSource, /vendors\.map/);
});

test("vendor account rows keep the summary line to one account name", () => {
  const accountMeta =
    vendorAccountsSource.match(
      /<div className="provider-row-meta">[\s\S]*?<\/div>/,
    )?.[0] ?? "";
  assert.match(accountMeta, /vendor-account-label/);
  assert.match(accountMeta, /\{accountName\}/);
  assert.match(accountMeta, /\{duplicateLabel\}/);
  assert.doesNotMatch(accountMeta, /defaultModelId|provider-meta-dot|font-mono/);
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
  assert.match(settingsPageSource, /general: <IconSliders/);
  assert.match(settingsPageSource, /ai: <IconSparkles/);
  assert.doesNotMatch(settingsPageSource, /usage: <IconActivity/);
  assert.match(settingsPageSource, /shortcuts: <IconKeyboard/);
  assert.match(settingsPageSource, /instructions: <IconFileText/);
  assert.match(settingsPageSource, /agent: <IconBot/);
  assert.match(settingsPageSource, /import: <IconDownload/);
  assert.match(settingsPageSource, /projects: <IconArchive/);
  assert.match(settingsPageSource, /about: <IconInfo/);
  assert.doesNotMatch(settingsPageSource, /general: <IconSettings/);
  assert.doesNotMatch(settingsPageSource, /agent: <IconConfig/);
  assert.doesNotMatch(settingsPageSource, /import: <IconSnapshot/);
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
    "general",
    "ai",
    "shortcuts",
    "instructions",
    "agent",
    "import",
    "projects",
    "about",
  ].map((id) => settingsSearchSource.indexOf(`id: "${id}"`));
  assert.ok(navOrder.every((index) => index >= 0));
  assert.deepEqual(navOrder, [...navOrder].sort((a, b) => a - b));
  const generalStart = settingsSearchSource.indexOf('id: "general"');
  const aiStart = settingsSearchSource.indexOf('id: "ai"');
  const shortcutsStart = settingsSearchSource.indexOf('id: "shortcuts"');
  const generalEntry = settingsSearchSource.slice(generalStart, aiStart);
  const aiEntry = settingsSearchSource.slice(aiStart, shortcutsStart);
  assert.equal(settingsSearchSource.indexOf('id: "usage"'), -1);
  assert.doesNotMatch(generalEntry, /settings\.defaultsTitle/);
  assert.match(aiEntry, /settings\.defaultsTitle/);
  assert.match(aiEntry, /settings\.commandShell/);
  assert.match(aiEntry, /settings\.promptEnhancementModelTitle/);
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
    "settings.nav.general",
    "settings.nav.ai",
    "settings.nav.shortcuts",
    "settings.nav.instructions",
    "settings.nav.models",
    "settings.nav.skills",
    "settings.nav.mcp",
    "settings.nav.subagents",
    "settings.nav.import",
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
});

test("marketplace source settings live inside the Plugins marketplace surface", () => {
  assert.match(pluginsPageSource, /<MarketplaceSourceSettings/);
  assert.match(marketplaceSettingsSource, /api\.marketRefresh\(true\)/);
  assert.match(marketplaceSettingsSource, /settings\.marketProvider/);
  assert.match(marketplaceSettingsSource, /<SettingsMenuSelect/);
  assert.doesNotMatch(marketplaceSettingsSource, /<Select/);
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
