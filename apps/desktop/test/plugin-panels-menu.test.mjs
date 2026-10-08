import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Issue #998 item 2: the work panel's New launcher only drew `contributes.views`
 * plugins, so a plugin that opens its own `ui.panel` window had no main-window
 * entry at all. The launcher's second group lists the openable panels the main
 * process resolved, and a row click opens the window through the same channel
 * the installed row uses.
 */

const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readFile(
  new URL("../../../packages/shared/src/types/plugins.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const uiIpcSource = await readFile(
  new URL("../electron/main/ipc/plugin-ui-ipc.ts", import.meta.url),
  "utf8",
);
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const shellSource = await readFile(
  new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../src/stores/slices/catalog-slice.ts", import.meta.url),
  "utf8",
);
const initialStateSource = await readFile(
  new URL("../src/stores/slices/initial-state.ts", import.meta.url),
  "utf8",
);

test("the shared protocol carries a plugin-panels channel and meta type", () => {
  assert.match(protocolSource, /pluginPanels: "pi-desktop\/plugin\/panels"/);
  assert.match(
    sharedTypesSource,
    /export type PluginPanelMeta = \{\s*pluginId: string;[\s\S]*title: string;[\s\S]*\};/,
  );
});

test("the main process resolves openable panels like it resolves views", () => {
  const handler = uiIpcSource.slice(
    uiIpcSource.indexOf("IPC.invoke.pluginPanels"),
    uiIpcSource.indexOf("IPC.invoke.pluginScenicThemesDestinations"),
  );
  assert.ok(handler.length > 0);
  // The same permission the open channel enforces, so the launcher never
  // offers a row the row entry would refuse.
  assert.match(handler, /manifest\.ui\?\.panel/);
  assert.match(handler, /loaded\.permissions\.has\("ui\.panel"\)/);
  // Titles resolve against the host locale with the plugin name as fallback.
  assert.match(handler, /resolvePluginLocalizedString/);
  // A panel is an application-level window: activation scope must not filter it.
  assert.doesNotMatch(handler, /pluginActiveInProject/);
  // Stable order: localized title, then plugin id.
  assert.match(handler, /a\.title\.localeCompare\(b\.title\)/);
});

test("the store resolves panel meta like view meta", () => {
  assert.match(apiSource, /listPluginPanels: \(\) => invoke<PluginPanelMeta\[\]>\(IPC\.invoke\.pluginPanels\)/);
  assert.match(catalogSource, /refreshPluginPanels: async \(\) => \{[\s\S]*await api\.listPluginPanels\(\)[\s\S]*\} catch \{\s*set\(\{ pluginPanels: \[\] \}\);/);
  assert.match(initialStateSource, /pluginPanels: \[\]/);
  // Both the restore flow and plugin changes refresh the launcher inputs.
  assert.match(storeSource, /void get\(\)\.refreshPluginPanels\(\)/);
  assert.match(shellSource, /getState\(\)\.refreshPluginPanels\(\)/);
});

test("the launcher draws the panel group and opens panels in their own window", () => {
  // A second launcher group, labeled and hidden when the host resolved none.
  assert.match(workPanelSource, /work-panel-launcher-group-label/);
  assert.match(workPanelSource, /pluginPanels\.length > 0/);
  assert.match(workPanelSource, /t\("panel\.new\.pluginPanels"\)/);
  // Rows keep the launcher's own keyboard/button contract.
  assert.match(workPanelSource, /data-work-panel-launcher-item=\{`panel:\$\{panel\.pluginId\}`\}/);
  // Opening goes through the host channel the installed row uses; the New
  // page that hosted the click closes; failures report through the toast.
  assert.match(workPanelSource, /api\.openPluginPanel\(panel\.pluginId\)/);
  const selectPanel = workPanelSource.slice(
    workPanelSource.indexOf("const selectPanel"),
    workPanelSource.indexOf("const closeTabAndFocus"),
  );
  assert.ok(selectPanel.length > 0);
  assert.match(selectPanel, /closeTab\(sourceTabId\)/);
  assert.match(selectPanel, /\.catch\(/);
  // The group's rows carry the panel icon, imported from the shared icon set.
  assert.match(workPanelSource, /<IconPanel size=\{15\} \/>/);
  assert.match(workPanelSource, /\bIconPanel,/);
});