import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const setupSource = await read("../src/components/settings/ProviderSetupDialog.tsx");
const pickerSource = await read("../src/components/settings/ServicePicker.tsx");
const hookSource = await read("../src/components/settings/useProviderModels.ts");
const menuSource = await read("../src/components/settings/AnchoredMenu.tsx");
const styles = await loadStyles();

test("the service control is a searchable anchored menu, not a native select", () => {
  assert.match(setupSource, /<ServicePicker/);
  assert.doesNotMatch(setupSource, /NAMED_PRESET_GROUPS\.map/);
  assert.doesNotMatch(setupSource, /<optgroup/);
  assert.match(pickerSource, /<AnchoredMenu/);
  assert.match(pickerSource, /settings\.searchService/);
  assert.match(pickerSource, /haystack\.includes\(needle\)/);
  assert.match(pickerSource, /preset\.aliases/);
  assert.match(pickerSource, /hostOf\(preset\.baseUrl\)/);
  // Filtering stays in the renderer; a keystroke must not IPC.
  assert.doesNotMatch(pickerSource, /api\./);
});

test("the service menu portals above the dialog overlay and hides until measured", () => {
  const menu = styles.match(/\.provider-service-menu \{([^}]*)\}/);
  assert.ok(menu, ".provider-service-menu rule is missing");
  assert.match(menu[1], /position: fixed;/);
  assert.match(menu[1], /z-index: 60;/);
  assert.match(menu[1], /max-height: min\(400px, calc\(100vh - 120px\)\);/);
  assert.match(menu[1], /visibility: hidden;/);
  assert.match(styles, /\.provider-service-menu\.is-open \{[^}]*visibility: visible;/);
  assert.match(styles, /\.provider-service-results\s*\{[^}]*overflow-y: auto;/s);
  assert.match(pickerSource, /initialFocus="input"/);
  assert.match(pickerSource, /restoreFocus=\{restoreFocus\}/);
  assert.match(menuSource, /initialFocus === "input"/);
  assert.match(menuSource, /if \(restoreFocus\) triggerRef/);
});

test("service groups survive filtering and custom stays first", () => {
  assert.match(pickerSource, /id: CUSTOM_SERVICE/);
  assert.match(pickerSource, /settings\.presetGroupInternational/);
  assert.match(pickerSource, /settings\.presetGroupChina/);
  assert.match(pickerSource, /settings\.noServiceMatches/);
  assert.match(pickerSource, /role="option"/);
  // Custom is prepended so it is not buried under International.
  assert.ok(
    pickerSource.indexOf("id: CUSTOM_SERVICE") <
      pickerSource.indexOf("NAMED_PRESET_GROUPS.flatMap"),
    "custom should be listed before named vendors",
  );
});

test("named add-path discovery waits for a key and does not flash loading", () => {
  assert.match(setupSource, /discoveryActive/);
  assert.match(setupSource, /Boolean\(apiKey\.trim\(\)\)/);
  assert.match(setupSource, /custom \|\| Boolean\(apiKey\.trim\(\)\) \|\| Boolean\(provider\)/);
  // Loading is painted inside the debounced run, not when the effect starts.
  const runAt = hookSource.indexOf("const run = async");
  const loadingAt = hookSource.indexOf('status: "loading"');
  assert.ok(runAt !== -1 && loadingAt !== -1, "discovery run/loading missing");
  assert.ok(runAt < loadingAt, "loading must start inside the debounced run");
  assert.match(hookSource, /endpointChanged/);
  assert.match(hookSource, /FETCH_DEBOUNCE_MS/);
});
