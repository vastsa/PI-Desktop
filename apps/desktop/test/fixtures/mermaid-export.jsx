import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { FilesTab } from "../../src/components/workpanel/FilesTab";
import { Markdown } from "../../src/components/Markdown";
import { useAppStore } from "../../src/stores/app-store";
import { standaloneMermaidSvg } from "../../src/lib/mermaid-export";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: Object.fromEntries(
  ["en", "zh-CN"].map((locale) => [locale, { translation: catalogs[locale] }]),
), interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
window.mermaidFixture = {
  standaloneMermaidSvg,
  async openReadme(source) {
    window.piDesktop = {
      platform: "darwin",
      on() { return () => {}; },
      async invoke(channel) {
        if (channel === IPC.invoke.fsList) return { ok: true, data: { entries: [] } };
        if (channel === IPC.invoke.fsRead) return { ok: true, data: { kind: "text", content: source, size: source.length } };
        throw Error("Unexpected fixture IPC: " + channel);
      },
    };
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--font-sans", '\"Arial\", sans-serif');
    useAppStore.setState({ workspace: { path: "/fixture", name: "fixture" }, workPanelFileRequest: { seq: 1, path: "README.md" } });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><FilesTab /></I18nextProvider>));
  },
  async render(source, locale = "en", theme = "light") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--font-sans", '"Arial", sans-serif');
    await i18n.changeLanguage(locale);
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Markdown source={source} /></I18nextProvider>));
  },
  toast: () => useAppStore.getState().toasts.at(-1),
};
