import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("theme variables remain host-generated and plugin-scoped", () => {
  const runtime = read("electron/main/plugin-runtime.ts");
  const shell = read("src/features/app/useAppShellRuntime.tsx");
  assert.match(runtime, /themes\.setVariables/);
  assert.match(runtime, /validatePluginThemeVariables/);
  assert.match(runtime, /formatPluginThemeVariables/);
  assert.match(runtime, /THEME_VARIABLES_SETTINGS_KEY/);
  assert.match(runtime, /delete stored\[THEME_VARIABLES_SETTINGS_KEY\]/);
  assert.match(runtime, /Read the raw private record/);
  assert.match(shell, /pluginTheme\.variablesCss/);
});

test("scenic settings destinations are permission-gated and host-rendered", () => {
  const ipc = read("electron/main/ipc/plugin-ui-ipc.ts");
  const page = read("src/features/settings/SettingsPage.tsx");
  const component = read("src/components/settings/PluginScenicThemesDestination.tsx");
  assert.match(ipc, /pluginScenicThemesDestinations/);
  assert.match(ipc, /ui\.settings/);
  assert.match(ipc, /ui\.theme/);
  assert.match(page, /settings\.groupExtensions/);
  assert.match(page, /PluginScenicThemesDestination/);
  assert.match(component, /aria-pressed/);
  assert.doesNotMatch(component, /<iframe/);
});

test("settings extension surfaces are cleaned up by the renderer lifecycle", () => {
  const services = read("electron/main/services/plugin-services.ts");
  const lifecycle = read("electron/main/ipc/plugin-ipc.ts");
  assert.doesNotMatch(services, /pluginSettingsViews/);
  assert.doesNotMatch(lifecycle, /pluginSettingsViews/);
});

test("scenic settings metadata is host-validated before it reaches the renderer", () => {
  const ipc = read("electron/main/ipc/plugin-ui-ipc.ts");
  const protocol = read("../../packages/shared/src/protocol.ts");
  const api = read("src/lib/api.ts");

  assert.match(protocol, /pluginScenicThemesDestinations/);
  assert.match(ipc, /pluginScenicThemesDestinations/);
  assert.match(ipc, /scenicThemes/);
  assert.match(ipc, /ui\.settings/);
  assert.match(ipc, /ui\.theme/);
  assert.match(ipc, /previewUrl/);
  assert.match(ipc, /themeAssetUrl/);
  assert.match(ipc, /theme\?\.pluginId === pluginId/);
  assert.match(api, /listPluginScenicThemesDestinations/);
});
