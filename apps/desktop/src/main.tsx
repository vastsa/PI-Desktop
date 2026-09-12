import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog, resolveLocale } from "@pi-desktop/i18n";
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
const resources = Object.fromEntries(
  Object.entries(catalogs).map(([lng, catalog]) => [
    lng,
    { translation: flattenCatalog(catalog as unknown as Record<string, unknown>) },
  ]),
);

void i18n.use(initReactI18next).init({
  lng: locale,
  fallbackLng: "en",
  resources,
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
  const crashCatalog =
    catalogs[resolveLocale(i18n.resolvedLanguage ?? i18n.language ?? locale)];
  // Built with DOM nodes, not markup: the error text is untrusted and must not
  // be interpreted as HTML.
  const panel = document.createElement("div");
  panel.style.cssText =
    "padding:24px;font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#181818;color:#fff;height:100%";
  const heading = document.createElement("h1");
  heading.style.cssText = "margin:0 0 8px;font-size:16px";
  heading.textContent = crashCatalog.app.uiCrashed;
  const detail = document.createElement("pre");
  detail.style.cssText = "white-space:pre-wrap;color:#fca5a5";
  detail.textContent = String(error);
  panel.append(heading, detail);
  rootEl.replaceChildren(panel);
}
