import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { StorageSettingsSection } from "../../apps/desktop/src/features/settings/StorageSettingsSection";

await i18n.use(initReactI18next).init({
  lng: "zh-CN", interpolation: { escapeValue: false },
  resources: { "zh-CN": { translation: catalogs["zh-CN"] } },
});
createRoot(document.getElementById("root")).render(<main style={{ padding: 32 }}><StorageSettingsSection /></main>);

// Observe visible completion instead of relying on arbitrary delays.
window.storageDirectoryWait = (kind) => new Promise((resolve, reject) => {
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => finish(new Error("Storage UI did not reach " + kind)), 15000);
  function finish(error, value) { clearTimeout(timer); observer.disconnect(); error ? reject(error) : resolve(value); }
  function check() {
    const error = document.querySelector('[role="alert"]');
    if (error) return finish(new Error(error.textContent));
    const node = document.querySelector(kind === "ready" ? '.settings-storage button' : '.settings-storage-confirmation');
    if (node && (kind !== "ready" || !node.disabled)) finish(null, document.querySelector('.settings-storage').textContent);
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  check();
});
