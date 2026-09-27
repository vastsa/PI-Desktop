import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const chooserSource = await read("../src/components/settings/ServiceChooser.tsx");
const fieldsSource = await read("../src/components/settings/ProviderConnectionFields.tsx");
const catalogSource = await read("../src/components/settings/service-catalog.ts");
const hookSource = await read("../src/components/settings/useProviderModels.ts");
const subagentPickerSource = await read("../src/components/settings/SubagentModelPicker.tsx");
const menuSource = await read("../src/components/settings/AnchoredMenu.tsx");
const styles = await loadStyles();

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule is missing`);
  return match[1];
};

test("platform setup opens directly while the upstream searchable chooser remains unwired", () => {
  assert.doesNotMatch(setupSource, /ServiceChooser|chooserOpen|chooserView/);
  assert.match(setupSource, /\{formView\}/);
  assert.match(setupSource, /<ProviderConnectionFields/);
  assert.doesNotMatch(setupSource, /<ServicePicker/);
  assert.doesNotMatch(setupSource, /<optgroup/);
  assert.match(chooserSource, /settings\.searchService/);
  assert.match(chooserSource, /autoFocus/);
  // Matching itself is covered behaviorally in service-catalog.test.mjs.
  assert.match(chooserSource, /filterServiceOptions\(serviceOptions, query\)/);
  assert.match(chooserSource, /filterServiceOptions\(subscriptionOptions, query\)/);
  // Filtering stays in the renderer; a keystroke must not IPC.
  assert.doesNotMatch(chooserSource, /\bapi\./);
  assert.doesNotMatch(catalogSource, /\bapi\.\w+\(/);
});

test("the retained upstream chooser keeps subscriptions and custom endpoints outside platform setup", () => {
  assert.match(chooserSource, /\[customServiceOption\(t\), \.\.\.namedServiceOptions\(t\)\]/);
  // The custom endpoint is the group's first tile, ahead of every named host.
  const customAt = chooserSource.indexOf("customServiceOption(t)");
  const namedAt = chooserSource.indexOf("namedServiceOptions(t)");
  assert.ok(customAt > 0 && customAt < namedAt, "the custom endpoint leads the API-key group");
  assert.match(chooserSource, /settings\.chooserSubscriptions/);
  assert.match(chooserSource, /settings\.chooserApiKeys/);
  const subscriptionsAt = chooserSource.indexOf("settings.chooserSubscriptions");
  const apiKeysAt = chooserSource.indexOf("settings.chooserApiKeys");
  assert.ok(subscriptionsAt < apiKeysAt, "subscriptions render above API services");
  // One vendor can hold several accounts, so existing ones never disable it.
  assert.match(chooserSource, /existing accounts do not disable a\s+vendor/);
  assert.match(chooserSource, /vendors\.map/);
  // Neither creation nor editing mounts the chooser or offers subscription login.
  assert.doesNotMatch(setupSource, /onPickSubscription|vendors=|<ServiceChooser/);
  assert.doesNotMatch(chooserSource, /presetGroupInternational|presetGroupChina/);
  assert.doesNotMatch(chooserSource, /NAMED_PRESET_GROUPS/);
  assert.doesNotMatch(catalogSource, /NAMED_PRESET_GROUPS/);
});

test("the chooser answers the keyboard and never dead-ends", () => {
  // Enter picks the first match, preferring a service over a browser sign-in.
  assert.match(chooserSource, /event\.key === "Enter"/);
  assert.match(chooserSource, /pickEnterTarget/);
  assert.match(chooserSource, /is-active/);
  assert.match(chooserSource, /ArrowDown/);
  assert.match(chooserSource, /ArrowUp/);
  assert.match(chooserSource, /searchRef\.current\?\.focus\(\)/);
  // No match still offers the custom endpoint.
  assert.match(chooserSource, /settings\.noServiceMatches/);
  assert.match(chooserSource, /settings\.useCustomEndpoint/);
  assert.match(chooserSource, /pickService\(CUSTOM_SERVICE\)/);
  assert.match(chooserSource, /data-service-id=\{option\.id\}/);
});

test("chooser tiles are toned in-flow surfaces without strokes (D297)", () => {
  const tile = rule(".service-chooser-tile");
  assert.match(tile, /border: 0;/);
  assert.match(tile, /background: var\(--ds-tile\);/);
  assert.doesNotMatch(tile, /border: (?!0;)/);
  assert.match(rule(".service-chooser-grid"), /repeat\(auto-fill, minmax\(200px, 1fr\)\)/);
  assert.match(rule(".service-chooser-groups"), /overflow-y: auto;/);
  for (const selector of [
    ".service-chooser-search",
    ".service-chooser-empty",
    ".provider-chosen",
    ".provider-service-chip",
  ]) {
    assert.doesNotMatch(rule(selector), /\bborder(-(top|right|bottom|left|color|width|style))?:/, selector);
  }
});

test("the platform service chip displays a fixed endpoint without a Change action", () => {
  assert.match(fieldsSource, /provider-service-chip/);
  assert.match(fieldsSource, /settings\.presetAiPlatform/);
  assert.match(fieldsSource, /provider-service-chip-host">\{AI_PLATFORM_BASE_URL\}/);
  assert.doesNotMatch(fieldsSource, /settings\.changeService|onChangeService|type="url"/);
  assert.doesNotMatch(setupSource, /settings\.changeServiceTitle/);
});

test("the shared service menu still portals above dialogs for model pickers", () => {
  const menu = rule(".provider-service-menu");
  assert.match(menu, /position: fixed;/);
  assert.match(menu, /z-index: 60;/);
  assert.match(menu, /max-height: min\(400px, calc\(100vh - 120px\)\);/);
  assert.match(menu, /visibility: hidden;/);
  assert.match(styles, /\.provider-service-menu\.is-open \{[^}]*visibility: visible;/);
  assert.match(styles, /\.provider-service-results\s*\{[^}]*overflow-y: auto;/s);
  assert.match(subagentPickerSource, /menuClassName="provider-service-menu"/);
  assert.match(subagentPickerSource, /initialFocus="input"/);
  assert.match(menuSource, /initialFocus === "input"/);
  assert.match(menuSource, /anchorRef\?\.current \?\? triggerRef\.current/);
});

test("platform discovery requires an entered or saved key and does not flash loading", () => {
  assert.match(setupSource, /discoveryActive/);
  assert.match(setupSource, /allowedProvider && Boolean\(apiKey\.trim\(\) \|\| provider\?\.hasSecret\)/);
  assert.doesNotMatch(setupSource, /custom \|\| Boolean\(apiKey/);
  // Loading is painted inside the debounced run, not when the effect starts.
  const runAt = hookSource.indexOf("const run = async");
  const loadingAt = hookSource.indexOf('status: "loading"');
  assert.ok(runAt !== -1 && loadingAt !== -1, "discovery run/loading missing");
  assert.ok(runAt < loadingAt, "loading must start inside the debounced run");
  assert.match(hookSource, /endpointChanged/);
  assert.match(hookSource, /FETCH_DEBOUNCE_MS/);
});

test("the connection status line answers whether the key worked", () => {
  assert.match(fieldsSource, /export function ConnectionStatus/);
  assert.match(fieldsSource, /aria-live="polite"/);
  assert.match(fieldsSource, /settings\.connectionKeyHint/);
  assert.match(fieldsSource, /settings\.connectionChecking/);
  assert.match(fieldsSource, /settings\.connectionReady/);
  assert.match(fieldsSource, /canRecommendFrom\(discovery, named\)/);
  assert.match(fieldsSource, /<ModelsFetchErrorMessage error=\{discovery\.error\} variant="status" \/>/);
  // The status sits under the key on a named service.
  const keyAt = fieldsSource.indexOf("provider-setup-key");
  const statusAt = fieldsSource.indexOf("{status}", keyAt);
  assert.ok(keyAt !== -1 && statusAt > keyAt, "status follows the key field");
});
