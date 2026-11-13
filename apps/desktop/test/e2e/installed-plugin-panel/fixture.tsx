import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, type PluginSummary } from "@pi-desktop/shared";
import { PluginsPage } from "../../../src/pages/PluginsPage";
import { useAppStore } from "../../../src/stores/app-store";
import "../../../src/styles/tokens.css";
import "../../../src/styles/base.css";
import "../../../src/styles/ui-kit.css";
import "../../../src/styles/plugins.css";

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(catalogs.en) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) },
  },
  interpolation: { escapeValue: false },
});

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const t = (key: string, options: Record<string, unknown> = {}) => {
  check(i18n.exists(key), `Missing translation: ${key}`);
  return String(i18n.t(key, options));
};
const nextTask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    resolve();
  };
  channel.port2.postMessage(null);
});
async function until(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 5_000;
  while (!predicate() && performance.now() < deadline) await nextTask();
  check(predicate(), message);
}
async function click(button: HTMLButtonElement | undefined) {
  check(button && !button.disabled, "Expected an enabled button");
  flushSync(() => button.click());
  await nextTask();
}
function buttonNamed(container: ParentNode, name: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name);
}
function card(name: string) {
  const node = [...document.querySelectorAll<HTMLElement>('[role="listitem"]')]
    .find((row) => row.querySelector(".plugins-row-name")?.textContent === name);
  check(node, `Missing installed plugin card: ${name}`);
  return node;
}

const panel: PluginSummary = {
  id: "fixture.panel", name: "Panel plugin", version: "1.0.0",
  enabled: true, status: "ready", source: "installed", permissions: ["ui.panel"],
  ui: { panel: "panel.html" },
  settings: [{ key: "greeting", title: "Greeting", type: "string", default: "Hello" }],
};
const updating: PluginSummary = {
  ...panel, id: "fixture.updating", name: "Updating panel plugin",
  updateAvailable: { version: "1.1.0", url: "https://example.invalid/plugin.piplug", shasum: "0".repeat(64) },
};
const headless: PluginSummary = {
  ...panel, id: "fixture.headless", name: "Headless plugin", ui: undefined, permissions: [],
};
const disabled: PluginSummary = {
  ...panel, id: "fixture.disabled", name: "Disabled panel plugin", enabled: false, status: "disabled",
};
let plugins: PluginSummary[] = [];
let refuseOpen = false;
const openRequests: unknown[] = [];
const unexpected: string[] = [];
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

// Only the preload/Host boundary is replaced. The page, hook, store, API,
// localization, settings sheet, scope picker and menu use production wiring.
Object.defineProperty(window, "piDesktop", { value: {
  platform: "win32",
  on() { return () => {}; },
  async invoke(channel: string, input: unknown) {
    let data: unknown;
    switch (channel) {
      case IPC.invoke.projectList: data = { projects: [] }; break;
      case IPC.invoke.pluginList: data = { plugins: structuredClone(plugins) }; break;
      case IPC.invoke.pluginServices: data = []; break;
      case IPC.invoke.marketCheckUpdates: data = { updates: [] }; break;
      case IPC.invoke.marketReviewSummaries:
      case IPC.invoke.marketReviewTickers: data = {}; break;
      case IPC.invoke.pluginOpenPanel:
        openRequests.push(input);
        if (refuseOpen) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Fixture panel permission denied" } };
        break;
      case IPC.invoke.pluginDisable:
        plugins = plugins.map((item) => item.id === input ? { ...item, enabled: false, status: "disabled" } : item);
        break;
      case IPC.invoke.pluginSetAutoUpdate:
        check(typeof input === "object" && input !== null && "id" in input && "enabled" in input, "Invalid auto-update payload");
        plugins = plugins.map((item) => item.id === input.id ? { ...item, autoUpdate: Boolean(input.enabled) } : item);
        break;
      default:
        unexpected.push(channel);
        throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
} });

const root = createRoot(document.getElementById("root")!);
const locales: string[] = [];
Object.assign(window, { installedPluginPanelProbe: async () => {
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      plugins = structuredClone([panel, updating, headless, disabled]);
      openRequests.length = 0;
      refuseOpen = false;
      useAppStore.setState({ plugins: [], toasts: [] });
      flushSync(() => root.render(<PluginsPage key={locale} />));
      await until(() => document.querySelectorAll('[role="listitem"]').length === 4, "Installed plugins did not load through the Host API");

      const openLabel = t("plugins.openPanel");
      check(!buttonNamed(card(headless.name), openLabel), "A plugin without a panel offered Open panel");
      check(!buttonNamed(card(disabled.name), openLabel), "A disabled plugin offered Open panel");
      const open = buttonNamed(card(panel.name), openLabel);
      check(open, "Enabled panel plugin must offer Open panel even without an update");
      check(open.tabIndex === 0, "Open panel is not keyboard focusable");
      await click(open);
      const updateButton = buttonNamed(card(updating.name), t("plugins.updateTo", { version: "1.1.0" }));
      check(updateButton && !updateButton.disabled, "Open panel displaced the update action");
      await click(buttonNamed(card(updating.name), openLabel));
      check(JSON.stringify(openRequests) === JSON.stringify([panel.id, updating.id]), "Panel clicks did not reach the existing API with the owning plugin IDs");

      await click(buttonNamed(card(panel.name), t("plugins.openSettings")));
      await until(() => document.querySelector('[role="dialog"] input') instanceof HTMLInputElement, "Settings did not open");
      check(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value === "Hello", "Settings lost the owning plugin fields");
      await click(buttonNamed(document, t("plugins.closeSettings")));
      check(!document.querySelector('[role="dialog"]'), "Settings did not close");
      check(buttonNamed(card(headless.name), t("plugins.openSettings")), "Headless plugin settings were hidden with its panel action");

      const menuLabel = t("plugins.rowActions", { name: panel.name });
      await click(buttonNamed(card(panel.name), menuLabel));
      await until(() => document.querySelector('[role="menu"]'), "Row menu did not open");
      check(buttonNamed(document, t("plugins.uninstall")), "Row menu lost uninstall");
      await click(buttonNamed(document, t("plugins.enableAutoUpdate")));
      await until(() => useAppStore.getState().plugins.find((item) => item.id === panel.id)?.autoUpdate, "Auto-update did not persist through the row menu");
      await click(buttonNamed(card(panel.name), menuLabel));
      check(buttonNamed(document, t("plugins.disableAutoUpdate")), "Row menu did not reflect the new auto-update setting");
      await click(buttonNamed(card(panel.name), menuLabel));

      const scopeLabel = `${t("extensions.scope.ariaLabel", { name: panel.name })}: ${t("extensions.scope.global")}`;
      await click(buttonNamed(card(panel.name), scopeLabel));
      await click(buttonNamed(document, t("extensions.scope.off")));
      await until(() => useAppStore.getState().plugins.find((item) => item.id === panel.id)?.enabled === false, "Scope control did not disable the plugin");
      check(!buttonNamed(card(panel.name), openLabel), "Disabled card retained a launch action");
      check(JSON.stringify(openRequests) === JSON.stringify([panel.id, updating.id]), "Disabling or operating other controls unexpectedly launched a panel");
      check(buttonNamed(card(panel.name), menuLabel), "Disabled card lost its row menu");

      refuseOpen = true;
      await click(buttonNamed(card(updating.name), openLabel));
      await until(() => useAppStore.getState().toasts.some((toast) => toast.message === "Fixture panel permission denied" && toast.variant === "error"), "Host refusal was not reported through the page's error handling");
      check(JSON.stringify(openRequests) === JSON.stringify([panel.id, updating.id, updating.id]), "Host refusal caused an unexpected launch request");
      check(!unexpected.length && !errors.length, `Unexpected IPC/errors: ${unexpected}; ${errors}`);
      flushSync(() => root.render(null));
      locales.push(locale);
    }
    return { ok: true, locales, checks: [
      "panel-declaration-and-enabled-gates", "open-with-and-without-update",
      "settings-and-menu-controls", "disable-through-scope-control", "host-error-feedback",
    ] };
  } catch (error) {
    return { ok: false, locales, error: error instanceof Error ? error.stack : String(error), unexpected, errors };
  } finally {
    root.unmount();
  }
} });
