// Production SettingsPage and API; fixtures stop at the isolated preload boundary.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const baseline = {
  dataPath: "/old/PI-Desktop", browserPath: "/old/chromium", managed: true,
  cacheBytes: 2 * 1024 * 1024, pendingPath: null, lastError: null,
  backupPaths: ["/previous/PI-Desktop"],
};
let info = { ...baseline };
let chosen = "/new/PI-Desktop";
let readError = false;
let operationError = false;
let operationGate = null;
const calls = [];
window.piDesktop = {
  platform: "darwin", locale: "en-US",
  on: () => () => {},
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.storageGet:
        if (readError) return { ok: false, error: { code: "TEST", message: "storage unavailable" } };
        data = info;
        break;
      case IPC.invoke.storageChoose: data = chosen; break;
      case IPC.invoke.storageMigrate:
      case IPC.invoke.storageClearCache:
      case IPC.invoke.storageRemoveBackup:
        calls.push({ channel, input });
        if (operationGate) await operationGate;
        if (operationError) return { ok: false, error: { code: "TEST", message: "target not writable" } };
        break;
      case IPC.invoke.pluginScenicThemesDestinations: data = []; break;
      case IPC.invoke.systemFontsList: data = []; break;
      default: data = null;
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", interpolation: { escapeValue: false }, resources: Object.fromEntries(Object.entries(catalogs).map(([language, catalog]) => [language, { translation: catalog }])) });
useAppStore.setState({ settingsTab: "general", settings: { language: "en", theme: "light", defaultMode: "agent", enterToSend: true }, version: null });
const root = createRoot(document.getElementById("root"));
let revision = 0;
const assert = (value, message) => { if (!value) throw new Error(message); };
const text = (key) => i18n.t(key);
const scope = () => document.querySelector(".settings-storage");
const button = (key) => [...scope().querySelectorAll("button")].find((node) => node.textContent.trim() === text(key));
const click = (key) => {
  const target = button(key);
  assert(target && !target.disabled, `Expected enabled ${key}`);
  flushSync(() => target.click());
};
const settled = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function mount(overrides = {}) {
  info = { ...baseline, ...overrides };
  flushSync(() => root.render(<SettingsPage key={++revision} />));
  await settled();
}
window.storageSettingsProbe = async () => {
  const checks = [];
  await mount();
  assert(scope().textContent.includes(baseline.dataPath), "Current data path must be visible");
  assert(scope().textContent.includes("2 MiB"), "Reclaimable size must be visible");
  chosen = null;
  click("settings.storage.choose");
  await settled();
  assert(!scope().querySelector(".settings-storage-confirmation"), "Canceling native picker must not begin migration");
  chosen = "/new/PI-Desktop";
  click("settings.storage.choose");
  await settled();
  assert(scope().querySelector(".settings-storage-confirmation").textContent.includes(chosen), "Chosen target must be shown before confirmation");
  assert(scope().querySelector(".settings-storage-confirmation").textContent.includes(baseline.browserPath), "A separate Chromium source must be shown in migration scope");
  assert(document.activeElement === scope().querySelector(".settings-storage-confirmation h4"), "Migration confirmation must receive keyboard focus");
  assert(scope().textContent.includes("Project source folders stay where they are"), "Confirmation must explain migration scope");
  click("common.cancel");
  assert(calls.length === 0, "Cancel must not request migration");
  checks.push("choose and cancel");

  click("settings.storage.choose");
  await settled();
  operationError = true;
  click("settings.storage.migrateRestart");
  await settled();
  assert(calls.length === 1 && calls[0].channel === IPC.invoke.storageMigrate, "Confirm must reach typed migration IPC");
  assert(calls[0].input.path === chosen && calls[0].input.language === "en", "Migration must carry target and resolved locale");
  assert(scope().querySelector('[role="alert"]').textContent.includes("target not writable"), "Failure must be visible");
  assert(scope().textContent.includes(baseline.dataPath), "Failure must retain active path");
  operationError = false;
  let release;
  operationGate = new Promise((resolve) => { release = resolve; });
  click("settings.storage.migrateRestart");
  await settled();
  assert(button("settings.storage.restarting").disabled && button("settings.storage.choose").disabled, "Restart preparation must prevent duplicate operations");
  release();
  operationGate = null;
  await settled();
  assert(calls.length === 2 && button("settings.storage.restarting").disabled, "A failed operation can be retried and then stays locked until restart");
  checks.push("migration failure and retry");

  await mount();
  click("settings.storage.clearCache");
  assert(scope().querySelector(".settings-storage-confirmation").textContent.includes("plugin data and models are preserved"), "Cache confirmation must state protected data");
  click("common.cancel");
  assert(calls.length === 2, "Canceling cache cleanup must do nothing");
  click("settings.storage.clearCache");
  click("settings.storage.cacheRestart");
  await settled();
  assert(calls.at(-1).channel === IPC.invoke.storageClearCache && calls.at(-1).input.language === "en", "Confirmed cleanup must reach cache IPC");
  assert(button("settings.storage.choose").disabled, "Accepted cache cleanup must stay locked until restart");
  await mount();
  click("settings.storage.removeBackup");
  assert(scope().querySelector(".settings-storage-confirmation").textContent.includes("after verifying"), "Backup removal must advise verification");
  click("common.cancel");
  assert(calls.length === 3, "Canceling backup removal must do nothing");
  click("settings.storage.removeBackup");
  click("settings.storage.backupRestart");
  await settled();
  assert(calls.at(-1).channel === IPC.invoke.storageRemoveBackup, "Confirmed backup deletion must reach backup IPC");
  assert(button("settings.storage.choose").disabled, "Accepted backup removal must stay locked until restart");
  checks.push("cache and backup confirmations");

  await mount({ managed: false });
  assert(button("settings.storage.choose").disabled && button("settings.storage.clearCache").disabled && button("settings.storage.removeBackup").disabled, "Environment-owned locations must prohibit all mutations");
  assert(scope().textContent.includes("environment variable"), "Environment ownership must be explained");
  await mount({ pendingPath: "/pending", lastError: "Copy failed" });
  assert(button("settings.storage.choose").disabled && scope().textContent.includes("/pending"), "Pending migration must be visible and prevent duplicate operation");
  assert(scope().querySelector('[role="alert"]').textContent.includes("active location was not changed"), "Failed offline operation must explain recovery");
  await mount({ cacheBytes: 0, backupPaths: [] });
  assert(button("settings.storage.clearCache").disabled && !button("settings.storage.removeBackup"), "Empty cache and no backups must prevent meaningless cleanup");
  checks.push("ownership pending and empty states");

  readError = true;
  await mount();
  assert(scope().querySelector('[role="alert"]').textContent.includes("storage unavailable"), "Read failure must remain observable");
  readError = false;
  click("settings.storage.retry");
  await settled();
  assert(button("settings.storage.choose"), "Retry must restore the loaded storage controls");
  await i18n.changeLanguage("zh-CN");
  await settled();
  click("settings.storage.clearCache");
  click("settings.storage.cacheRestart");
  await settled();
  assert(calls.at(-1).input.language === "zh-CN", "Restart workflow must use current UI locale");
  assert(scope().textContent.includes("数据保存路径"), "Storage labels must translate with the UI");
  checks.push("read recovery and localization");
  root.unmount();
  return { ok: true, checks };
};
