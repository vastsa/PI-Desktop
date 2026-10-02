import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { flattenCatalog } from "@pi-desktop/i18n/locale-info";
import { en } from "@pi-desktop/i18n/locales/en";
import { MAC_TRAFFIC_LIGHT_EDGE_DIP } from "@pi-desktop/shared";
import App from "./App";
import { ErrorBoundary, RoutePending } from "./features/app/chrome";
import { initLanguageSync } from "./lib/app-language";
import { installScrollbarReveal } from "./lib/scrollbar-reveal";
import "./styles/globals.css";

const rendererSurface = new URLSearchParams(window.location.search).get("surface");
if (rendererSurface) document.documentElement.dataset.surface = rendererSurface;
document.documentElement.dataset.theme = "dark";
// Window-chrome layout differs per OS (traffic lights left on macOS,
// controls overlay right on Windows/Linux); set before first paint.
document.documentElement.dataset.platform =
  window.piDesktop?.platform ?? "darwin";
// The macOS traffic lights are native views with a fixed footprint; the space
// the shell leaves clear for them derives from the same shared constant the
// main process positions them with (styles/tokens.css). Only macOS has them —
// the 0px default keeps Windows/Linux on the renderer-drawn controls.
if (document.documentElement.dataset.platform === "darwin") {
  document.documentElement.style.setProperty(
    "--ds-traffic-light-edge",
    `${MAC_TRAFFIC_LIGHT_EDGE_DIP}px`,
  );
}
// Scrollbars are transparent at rest (base.css); this marks the scrolling
// element so the thumb shows while it moves, not only under the pointer.
installScrollbarReveal(document);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element missing");
}
const rootContainer = rootEl;

function showRendererError(error: unknown): void {
  console.error("Renderer failed to start", error);
  // Build with DOM nodes rather than markup so error text is never interpreted.
  const panel = document.createElement("div");
  panel.style.cssText =
    "padding:24px;font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#181818;color:#fff;height:100%";
  const heading = document.createElement("h1");
  heading.style.cssText = "margin:0 0 8px;font-size:16px";
  heading.textContent = i18n.t("app.uiCrashed", {
    defaultValue: "Something went wrong with the interface",
  });
  const detail = document.createElement("pre");
  detail.style.cssText = "white-space:pre-wrap;color:#fca5a5";
  detail.textContent = String(error);
  panel.append(heading, detail);
  rootContainer.replaceChildren(panel);
}

const PluginLauncher = React.lazy(() =>
  import("./components/PluginLauncher").then((module) => ({
    default: module.PluginLauncher,
  })),
);
const LiveVoiceWidget = React.lazy(() =>
  import("./features/voice/live/LiveVoiceWidget").then((module) => ({
    default: module.LiveVoiceWidget,
  })),
);

async function startRenderer(): Promise<void> {
  const root = ReactDOM.createRoot(rootContainer);
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: flattenCatalog(
          en as unknown as Record<string, unknown>,
        ),
      },
    },
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = "en";
  root.render(
    <React.StrictMode>
      <RoutePending />
    </React.StrictMode>,
  );
  await initLanguageSync();

  try {
    root.render(
      <React.StrictMode>
        <React.Suspense fallback={<RoutePending />}>
          {rendererSurface === "plugin-launcher" ? (
            <ErrorBoundary>
              <PluginLauncher />
            </ErrorBoundary>
          ) : rendererSurface === "live-voice-widget" ? (
            <ErrorBoundary>
              <LiveVoiceWidget />
            </ErrorBoundary>
          ) : (
            <App />
          )}
        </React.Suspense>
      </React.StrictMode>,
    );
  } catch (error) {
    showRendererError(error);
  }
}

void startRenderer().catch(showRendererError);
