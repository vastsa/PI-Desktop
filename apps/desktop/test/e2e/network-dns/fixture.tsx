import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import type { AppSettings } from "@pi-desktop/shared";
import { NetworkProxySection } from "../../../src/components/settings/NetworkProxySection";
import { useAppStore } from "../../../src/stores/app-store";
import { api } from "../../../src/lib/api";

let stored: AppSettings = {
  defaultMode: "agent", theme: "light", language: "en", enterToSend: true,
  networkProxy: { mode: "custom", url: "http://127.0.0.1:7890", bypass: "localhost" },
};
const originalProxy = JSON.stringify(stored.networkProxy);
const writes: AppSettings[] = [];
const toasts: string[] = [];
let failNextWrite = false;
let heldWrite: Promise<void> | undefined;
let releaseWrite: () => void = () => {};
Object.assign(window, { piDesktop: {
  platform: "win32", on() { return () => {}; },
  async invoke(channel: string, value: AppSettings) {
    if (channel === "pi-desktop/settings/get") return { ok: true, data: structuredClone(stored) };
    if (channel !== "pi-desktop/settings/set") throw new Error("Unexpected fixture IPC: " + channel);
    writes.push(structuredClone(value));
    if (failNextWrite) { failNextWrite = false; return { ok: false, error: { code: "INTERNAL_ERROR", message: "fixture write failed" } }; }
    if (heldWrite) { const pending = heldWrite; heldWrite = undefined; await pending; }
    stored = { ...stored, ...structuredClone(value) };
    return { ok: true, data: structuredClone(stored) };
  },
} });
await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings: await api.getSettings(), showToast: message => toasts.push(message) });
let remount: () => void = () => {};
function Harness() {
  const settings = useAppStore(state => state.settings);
  const [generation, setGeneration] = React.useState(0);
  remount = () => setGeneration(value => value + 1);
  return <NetworkProxySection key={generation} settings={settings} saveSettings={async patch => {
    await api.setSettings({ ...useAppStore.getState().settings, ...patch });
    useAppStore.setState({ settings: await api.getSettings() });
  }} />;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Harness />));
function waitFor(predicate: () => boolean, message: string): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(message)); }, 5000);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}
const control = <T extends HTMLElement>(key: string) => document.querySelector<T>('[aria-label="' + i18n.t(key) + '"]');
const toggle = () => control<HTMLButtonElement>("settings.dns")!;
const endpoint = () => control<HTMLInputElement>("settings.dnsServer");
const fallback = () => control<HTMLButtonElement>("settings.dnsFallback")!;
const click = (node: HTMLElement) => flushSync(() => node.click());
function input(value: string) {
  const node = endpoint()!;
  node.focus();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

Object.assign(window, { networkDnsProbe: async () => {
  if (!toggle()) throw new Error("Native DNS controls are missing from Network settings");
  const defaultOff = toggle().getAttribute("aria-checked") === "false" && !endpoint();
  click(toggle());
  await waitFor(() => Boolean(endpoint() && !endpoint()!.disabled), "DNS did not turn on");
  const secureDefault = stored.networkDns?.mode === "doh"
    && stored.networkDns.serverUrl === "https://1.1.1.1/dns-query"
    && stored.networkDns.allowSystemFallback === false;
  const count = writes.length;
  input("http://resolver.invalid/dns-query");
  await waitFor(() => endpoint()!.getAttribute("aria-invalid") === "true", "invalid endpoint was not announced");
  const invalidRejected = writes.length === count && Boolean(document.getElementById(endpoint()!.getAttribute("aria-describedby")!));
  input("https://127.0.0.1:9443/dns-query");
  await waitFor(() => Boolean(stored.networkDns?.serverUrl?.includes(":9443/") && !endpoint()!.disabled), "custom endpoint was not saved");
  heldWrite = new Promise(resolve => { releaseWrite = resolve; });
  click(fallback());
  await waitFor(() => fallback().disabled, "pending save did not disable controls");
  const busyCount = writes.length;
  click(fallback());
  const duplicatePrevented = writes.length === busyCount && toggle().disabled && endpoint()!.disabled;
  releaseWrite();
  await waitFor(() => Boolean(stored.networkDns?.allowSystemFallback && !fallback().disabled), "fallback preference was not saved");
  click(toggle());
  await waitFor(() => !endpoint() && !toggle().disabled, "DNS did not turn off");
  const disabledRetainsPreferences = stored.networkDns?.mode === "system"
    && stored.networkDns.serverUrl === "https://127.0.0.1:9443/dns-query"
    && stored.networkDns.allowSystemFallback === true;
  flushSync(() => remount());
  click(toggle());
  await waitFor(() => Boolean(endpoint() && !endpoint()!.disabled), "DNS did not restore after remount");
  const restored = endpoint()!.value === "https://127.0.0.1:9443/dns-query" && fallback().getAttribute("aria-checked") === "true";
  input("invalid");
  await waitFor(() => endpoint()!.getAttribute("aria-invalid") === "true", "invalid draft was not marked");
  click(toggle());
  await waitFor(() => !endpoint() && !toggle().disabled, "invalid draft prevented disabling DNS");
  const invalidDraftCanDisable = stored.networkDns?.serverUrl === "https://127.0.0.1:9443/dns-query";
  failNextWrite = true;
  click(toggle());
  await waitFor(() => toasts.length === 1 && !toggle().disabled, "save failure was not visible");
  return {
    defaultOff, secureDefault, invalidRejected, duplicatePrevented, disabledRetainsPreferences, restored, invalidDraftCanDisable,
    failureDoesNotPretendSuccess: toggle().getAttribute("aria-checked") === "false" && !endpoint(),
    unrelatedProxyPreserved: writes.every(write => JSON.stringify(write.networkProxy) === originalProxy),
  };
} });
