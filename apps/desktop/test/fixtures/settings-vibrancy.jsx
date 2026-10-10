import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { SearchDialog } from "../../src/components/SearchDialog";
import { useAppStore } from "../../src/stores/app-store";
import { useSessionSearchState } from "../../src/hooks/use-session-search";
import "../../src/styles/tokens.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/settings.css";
import "../../src/styles/overlays.css";

const errors = [];
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
let savedSettings = { defaultMode: "agent", theme: "light", language: "en", macosSidebarVibrancy: true };
let refuseWrite = false;
let saved = false;
const calls = [];
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, input) {
    calls.push(channel);
    if (channel === IPC.invoke.settingsSet) {
      if (refuseWrite) return { ok: false, error: { message: "Restart request could not be prepared", code: "INTERNAL_ERROR" } };
      savedSettings = input;
      saved = true;
      return { ok: true, data: input };
    }
    if (saved && [IPC.invoke.providersList, IPC.invoke.sessionList, IPC.invoke.settingsGet, IPC.invoke.appGetOnboarding].includes(channel)) {
      return { ok: false, error: { message: "Host is shutting down", code: "HOST_UNAVAILABLE" } };
    }
    switch (channel) {
      case IPC.invoke.settingsGet: return { ok: true, data: savedSettings };
      case IPC.invoke.sessionList: return { ok: true, data: { sessions: [] } };
      case IPC.invoke.appGetOnboarding: return { ok: true, data: { dismissed: true } };
      case IPC.invoke.providersList: return { ok: true, data: { providers: [] } };
      case IPC.invoke.sessionSearch: return { ok: true, data: { hits: [] } };
      case IPC.invoke.commandPaletteSearch: return { ok: true, data: { commands: [] } };
      case IPC.invoke.pluginScenicThemesDestinations: return { ok: true, data: [] };
      case IPC.invoke.systemFontsList: return { ok: true, data: [] };
      case IPC.invoke.commandShellList: return { ok: true, data: { shells: [], defaultShell: "bash" } };
      case IPC.invoke.appGetVersion: return { ok: true, data: { version: "0.17.0", platform: "darwin" } };
      case IPC.invoke.updatesGetState: return { ok: true, data: { status: "idle" } };
      default: return { ok: false, error: { message: "Unavailable fixture boundary: " + channel, code: "HOST_UNAVAILABLE" } };
    }
  },
};
await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings: savedSettings, settingsTab: "general" });
function Surface() {
  const [searchOpen, setSearchOpen] = useState(false);
  return <><button id="open-global-search" onClick={() => setSearchOpen(true)}>Search</button>
    <SettingsPage /><SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} /></>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<Surface />));

const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message);
}
const toggle = () => document.querySelector('[role="switch"][aria-label="Translucent sidebar"]');
const dialog = () => document.querySelector('[role="dialog"]');
const restart = () => [...dialog().querySelectorAll("button")].find((button) => button.textContent.trim() === "Restart");

window.settingsVibrancyProbe = async () => {
  await waitFor(toggle, "Vibrancy switch missing");
  flushSync(() => toggle().click());
  const asksBeforeWrite = !!dialog() && !saved && toggle().getAttribute("aria-checked") === "true";
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await waitFor(() => !dialog(), "Cancellation did not close confirmation");
  const cancelPreservesSetting = !saved && toggle().getAttribute("aria-checked") === "true";

  // Restart preparation errors must leave a retryable confirmation.
  refuseWrite = true;
  flushSync(() => toggle().click());
  flushSync(() => restart().click());
  await waitFor(() => dialog()?.querySelector('[role="alert"]'), "Write failure was not visible");
  const failedWriteStaysOpen = !!dialog() && toggle().getAttribute("aria-checked") === "true" && !saved;
  refuseWrite = false;
  flushSync(() => restart().click());
  await waitFor(() => saved && !dialog(), "Committed restart setting was incorrectly reported as failed");
  const persistedAndVisible = savedSettings.macosSidebarVibrancy === false
    && toggle().getAttribute("aria-checked") === "false";
  const noFalseSaveError = !document.querySelector('[role="dialog"] [role="alert"]');

  // Use the actual global-search entry point, then the page's anchor consumer.
  saved = false;
  flushSync(() => document.getElementById("open-global-search").click());
  flushSync(() => useSessionSearchState.getState().setQuery("GPU"));
  await waitFor(() => !!document.querySelector(".search-item-title"), "Description search returned no settings result");
  const hit = [...document.querySelectorAll(".search-item-title")].find((node) => /sidebar/i.test(node.textContent));
  if (!hit) throw new Error("Description-only search has no sidebar result");
  flushSync(() => hit.closest("button").click());
  await waitFor(() => toggle().closest(".settings-row").classList.contains("settings-anchor-flash"), "Description search did not locate the switch row");
  return { asksBeforeWrite, cancelPreservesSetting, failedWriteStaysOpen, persistedAndVisible, noFalseSaveError,
    descriptionHitHighlightsRow: true, errors };
};
