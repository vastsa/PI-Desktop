import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { Markdown } from "../../src/components/Markdown";
import { ToastHost } from "../../src/components/Toast";
import { useAppStore } from "../../src/stores/app-store";
import { isBlockingOverlayActive } from "../../src/lib/blocking-overlay";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: Object.fromEntries(
  ["en", "zh-CN"].map((locale) => [locale, { translation: catalogs[locale] }]),
), interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
window.tableFixture = {
  source: "Intro\n\n| **Product** | Note |\n| :--- | ---: |\n| Pi | 你好, world |\n| ZCode | say \"hi\"<br>again |\n\nSecond\n\n| Other |\n| --- |\n| untouched |",
  isBlockingOverlayActive,
  async render(source = this.source, locale = "en", theme = "light") {
    this.source = source;
    document.documentElement.dataset.theme = theme;
    await i18n.changeLanguage(locale);
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><main className="prose-chat" style={{ padding: 24 }}><Markdown source={source} /></main><ToastHost /></I18nextProvider>));
  },
  toast: () => useAppStore.getState().toasts.at(-1),
};
await window.tableFixture.render();
