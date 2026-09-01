import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsPageSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const settingsSearchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const providersSource = await readFile(
  new URL("../src/components/settings/ModelConfigPage.tsx", import.meta.url),
  "utf8",
);
const pluginsPageSource = await readFile(
  new URL("../src/pages/PluginsPage.tsx", import.meta.url),
  "utf8",
);
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
const mainSource = await readFile(
  new URL("../src/main.tsx", import.meta.url),
  "utf8",
);
const electronMainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const preloadSource = await readFile(
  new URL("../electron/preload/index.ts", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readFile(
  new URL("../../../packages/shared/src/types.ts", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();

test("Basics and AI tabs expose their respective app and AI controls", () => {
  const generalStart = settingsPageSource.indexOf('{tab === "general" && settings && (');
  const aiStart = settingsPageSource.indexOf('{tab === "ai" && settings && (');
  const shortcutsStart = settingsPageSource.indexOf(
    '{tab === "shortcuts" && settings && (',
  );
  const generalSource = settingsPageSource.slice(generalStart, aiStart);
  const aiSource = settingsPageSource.slice(aiStart, shortcutsStart);

  assert.match(generalSource, /settings\.language/);
  assert.match(generalSource, /settings\.languageAuto/);
  assert.match(generalSource, /"zh-CN"/);
  assert.doesNotMatch(generalSource, /defaultMode: value/);
  assert.doesNotMatch(generalSource, /enterToSend: !settings\.enterToSend/);
  assert.doesNotMatch(generalSource, /settings\.defaultsTitle/);
  assert.match(aiSource, /defaultMode: value/);
  assert.match(aiSource, /settings\.defaultsTitle/);
  assert.match(aiSource, /CommandShellRow/);
  assert.match(aiSource, /enterToSend: !settings\.enterToSend/);
  assert.match(aiSource, /LargePasteThresholdRow/);
  assert.match(settingsPageSource, /largePasteThreshold/);
  assert.match(settingsPageSource, /saveSettings\(\{ largePasteThreshold: next \}\)/);
  assert.doesNotMatch(settingsPageSource, /commandShellConfigured/);
  assert.match(
    aiSource,
    /defaultPermissionMode: e\.target\.value as GlobalPermissionMode/,
  );
  assert.match(aiSource, /"accept-edits"/);
});

test("language persists as part of shared app settings", () => {
  assert.match(sharedTypesSource, /language\?: "auto" \| "en" \| "zh-CN"/);
  assert.match(sharedTypesSource, /largePasteThreshold\?: number/);
});

test("basics gates developer tools behind a persisted developer mode", () => {
  assert.match(sharedTypesSource, /developerMode\?: boolean/);
  assert.match(settingsPageSource, /function DeveloperSection/);
  assert.match(settingsPageSource, /role="switch"/);
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

test("stored language drives i18n at startup and on settings change", () => {
  assert.match(languageSource, /export function initLanguageSync/);
  assert.match(languageSource, /changeLanguage/);
  assert.match(languageSource, /resolveLocale/);
  assert.match(mainSource, /initLanguageSync\(\)/);
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
});

test("default model selector shows every configured model under its provider", () => {
  const defaultModelPicker =
    providersSource.match(
      /visibleDefaultModelOptions\.map\(\(\{ provider, modelId \}\) => \{[\s\S]*?<\/li>/,
    )?.[0] ?? "";
  assert.notEqual(defaultModelPicker, "");
  assert.match(defaultModelPicker, /model-default-option-name">\{provider\.name\}/);
  assert.match(defaultModelPicker, /model-default-option-model font-mono">[\s\S]*?\{modelId\}/);
  assert.match(defaultModelPicker, /setDefaultModel\(provider, modelId\)/);
  assert.match(providersSource, /placeholder=\{t\("settings\.searchModels"\)\}/);
  assert.match(providersSource, /model-default-results/);
  assert.match(stylesSource, /\.model-default-results\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(stylesSource, /scrollbar-gutter: stable/);
});

test("model configuration separates AI services from independently removable vendor accounts", () => {
  assert.match(providersSource, /authKind !== OAUTH_AUTH_KIND/);
  assert.match(
    providersSource,
    /provider\.hasSecret \|\| provider\.hasOauth \|\| provider\.authKind === "none"/,
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
  assert.match(settingsSearchSource, /group: "core"/);
  assert.match(settingsSearchSource, /group: "agent"/);
  assert.match(settingsSearchSource, /group: "workspace"/);
  assert.match(settingsSearchSource, /group: "about"/);
  for (const key of [
    "settings.groupPersonal",
    "settings.groupAgent",
    "settings.groupWorkspace",
    "settings.groupAbout",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replace(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".")[1]}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".")[1]}:`));
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
  assert.doesNotMatch(generalEntry, /settings\.defaultsTitle/);
  assert.match(aiEntry, /settings\.defaultsTitle/);
  assert.match(aiEntry, /settings\.commandShell/);
  assert.match(settingsSearchSource, /keywordKeys/);
  assert.match(settingsSearchSource, /settings\.projectArchive/);
  assert.match(stylesSource, /\.settings-nav-item\s*\{/);
  assert.match(stylesSource, /\.settings-nav-group-label\s*\{/);
  assert.doesNotMatch(stylesSource, /\.settings-nav-group \+ \.settings-nav-group/);
  assert.doesNotMatch(stylesSource, /\.settings-nav-group-label[^}]*border/);
  assert.match(
    stylesSource,
    /\.settings-row\.settings-row-plain\s*\{[^}]*border-bottom:\s*0/s,
  );
});

test("marketplace source settings live inside the Plugins marketplace surface", () => {
  assert.match(pluginsPageSource, /<MarketplaceSourceSettings/);
  assert.match(marketplaceSettingsSource, /api\.marketRefresh\(true\)/);
  assert.match(marketplaceSettingsSource, /settings\.marketProvider/);
  assert.doesNotMatch(settingsPageSource, /ExtensionMarketSection/);
  assert.doesNotMatch(settingsPageSource, /tab === "extensions"/);
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
