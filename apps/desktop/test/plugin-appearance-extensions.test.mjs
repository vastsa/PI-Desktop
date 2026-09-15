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

test("settings destinations are permission-gated and use the isolated view host", () => {
  const ipc = read("electron/main/ipc/plugin-ui-ipc.ts");
  const page = read("src/features/settings/SettingsPage.tsx");
  const component = read("src/components/settings/PluginSettingsDestination.tsx");
  assert.match(ipc, /pluginSettingsDestinations/);
  assert.match(ipc, /ui\.settings/);
  assert.match(ipc, /pluginSettingsViews\.open/);
  assert.match(page, /settings\.groupExtensions/);
  assert.match(page, /PluginSettingsDestination/);
  assert.match(component, /pluginSettingsViewSetBounds/);
  assert.match(component, /pluginSettingsViewSetVisible/);
});

test("settings extension surfaces are cleaned up on plugin lifecycle changes", () => {
  const services = read("electron/main/services/plugin-services.ts");
  const lifecycle = read("electron/main/ipc/plugin-ipc.ts");
  const window = read("electron/main/bootstrap/window.ts");
  const shutdown = read("electron/main/bootstrap/shutdown.ts");
  assert.match(services, /pluginSettingsViews\.closePlugin/);
  assert.match(lifecycle, /pluginSettingsViews\.closePlugin/);
  assert.match(window, /pluginSettingsViews\.setWindow/);
  assert.match(shutdown, /pluginSettingsViews\.dispose/);
});
