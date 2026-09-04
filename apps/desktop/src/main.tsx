import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en, zhCN, flattenCatalog, resolveLocale } from "@pi-desktop/i18n";
import App from "./App";
import { PluginLauncher } from "./components/PluginLauncher";
import { initLanguageSync, resolveOsLocale } from "./lib/app-language";
import { installScrollbarReveal } from "./lib/scrollbar-reveal";
import "./styles/globals.css";

const rendererSurface = new URLSearchParams(window.location.search).get("surface");
if (rendererSurface) document.documentElement.dataset.surface = rendererSurface;
document.documentElement.dataset.theme = "dark";
// Window-chrome layout differs per OS (traffic lights left on macOS,
// controls overlay right on Windows/Linux); set before first paint.
document.documentElement.dataset.platform =
  window.piDesktop?.platform ?? "darwin";
// Scrollbars are transparent at rest (base.css); this marks the scrolling
// element so the thumb shows while it moves, not only under the pointer.
installScrollbarReveal(document);

const locale = resolveLocale(resolveOsLocale());

void i18n.use(initReactI18next).init({
  lng: locale,
  fallbackLng: "en",
  resources: {
    en: { translation: flattenCatalog(en as unknown as Record<string, unknown>) },
    "zh-CN": {
      translation: flattenCatalog(zhCN as unknown as Record<string, unknown>),
    },
  },
  interpolation: { escapeValue: false },
});

// Settings load async after mount; switch i18n when the stored language lands.
initLanguageSync();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element missing");
}

try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      {rendererSurface === "plugin-launcher" ? <PluginLauncher /> : <App />}
    </React.StrictMode>,
  );
} catch (error) {
  rootEl.innerHTML = `<div style="padding:24px;font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#181818;color:#fff;height:100%">
    <h1 style="margin:0 0 8px;font-size:16px">PI-Desktop failed to start UI</h1>
    <pre style="white-space:pre-wrap;color:#fca5a5">${String(error)}</pre>
  </div>`;
}
