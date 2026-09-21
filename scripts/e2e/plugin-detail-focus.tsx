import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { api } from "../../apps/desktop/src/lib/api";
import { usePluginsPage } from "../../apps/desktop/src/features/plugins/usePluginsPage";
import { MarketplacePanel } from "../../apps/desktop/src/features/plugins/MarketplacePanel";
import { PluginDetailSheet } from "../../apps/desktop/src/features/plugins/PluginDetailSheet";
import { usePluginBrowseState } from "../../apps/desktop/src/features/plugins/browse-state";

const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
const find = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const settle = async (predicate: () => boolean) => {
  for (let frame = 0; frame < 120; frame++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error("Marketplace did not settle");
};
function Probe() {
  const model = usePluginsPage();
  return <><input aria-label="Unrelated input" /><MarketplacePanel {...model} /><PluginDetailSheet {...model} /></>;
}
Object.assign(globalThis, { pluginDetailFocusProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const plugin = { id: "test.focus", name: "Focus test", description: "Test marketplace card", author: "Test",
    latestVersion: "1.0.0", updatedAt: "2026-09-01T00:00:00Z", permissionSummary: [], categories: [], versions: [], permissions: [] };
  // Fixture only the IPC boundary; the hook, card, sheet and close actions are real.
  Object.assign(api, {
    listProjects: async () => ({ projects: [] }), listPlugins: async () => ({ plugins: [] }),
    listPluginServices: async () => [], marketCheckUpdates: async () => ({}),
    marketSearch: async () => ({ plugins: [plugin] }), marketGetDetail: async () => ({ plugin }),
    onPluginChanged: () => () => {}, onPluginInstallProgress: () => () => {},
  });
  usePluginBrowseState.setState({ tab: "market" });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Probe /></I18nextProvider>));
  await settle(() => !!document.querySelector(".plugins-card-hit"));
  const card = find(".plugins-card-hit");
  const open = async () => {
    card.focus(); card.click();
    await settle(() => !!document.querySelector('[role="dialog"]'));
  };
  const escape = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(() => !document.querySelector('[role="dialog"]'));
  };
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await open(); await escape();
    check(document.activeElement !== card, `${theme}: Escape left the marketplace opener focused`);
  }
  card.focus();
  check(document.activeElement === card, "Dismissal removed keyboard focusability");
  await open();
  find(".plugins-sheet-scrim").click();
  await settle(() => !document.querySelector('[role="dialog"]'));
  check(document.activeElement !== card, "Pointer dismissal left the opener focused");
  await open();
  const input = find("input"); input.focus(); await escape();
  check(document.activeElement === input, "Dismissal stole unrelated focus");
  root.unmount(); container.remove();
  return "PASS: Escape/pointer dismissal clear opener focus; keyboard and unrelated focus remain available";
} });
