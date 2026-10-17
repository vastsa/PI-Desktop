import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppSettings, McpCatalogEntry, SkillCatalogEntry } from "@pi-desktop/shared";
import { McpMarketPanel } from "../../apps/desktop/src/components/settings/McpMarketPanel";
import { SkillMarketPanel } from "../../apps/desktop/src/components/settings/SkillMarketPanel";
import { api } from "../../apps/desktop/src/lib/api";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/settings.css";

declare global {
  var marketRetryProbe: () => Promise<unknown>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 8_000;
  while (!condition() && performance.now() < deadline) await painted();
  assert(condition(), message);
}

const settings = {
  defaultMode: "agent",
  theme: "system",
  enterToSend: true,
} satisfies AppSettings;

const skillEntry: SkillCatalogEntry = {
  id: "retry-skill",
  name: "Recovered Skill",
  description: "A catalog entry returned after retry.",
  url: "https://example.com/skills/retry-skill/SKILL.md",
  categories: ["coding"],
};
const mcpEntry: McpCatalogEntry = {
  id: "retry-server",
  name: "Recovered Server",
  description: "A registry entry returned after retry.",
  transport: "stdio",
  command: "node",
  args: [],
  categories: ["devtools"],
};

globalThis.marketRetryProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  api.getSettings = async () => structuredClone(settings);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (panel: "skill" | "mcp") =>
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          {panel === "skill" ? (
            <SkillMarketPanel installedIds={[]} onBack={() => {}} onInstalled={() => {}} />
          ) : (
            <McpMarketPanel installedIds={[]} onBack={() => {}} onInstalled={() => {}} />
          )}
        </I18nextProvider>,
      ),
    );
  const click = (element: HTMLElement | undefined | null) => {
    assert(element, "missing retry button");
    flushSync(() => element!.click());
  };
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    );
  const status = () => container.querySelector<HTMLElement>('[role="status"]')?.textContent ?? "";

  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      let skillCalls = 0;
      api.searchSkillMarket = async () => {
        skillCalls += 1;
        if (skillCalls === 1) return { entries: [], failedSources: ["anthropics/skills"] };
        if (skillCalls === 2) return { entries: [skillEntry], failedSources: ["obra/superpowers"] };
        return { entries: [skillEntry], failedSources: [] };
      };
      render("skill");
      await until(
        () => status().includes(i18n.t("settings.sklm.remoteError")) || status().includes(i18n.t("settings.sklm.remoteErrorQuery")),
        `${locale}: skill market error status missing`,
      );
      click(button(i18n.t("settings.sklm.retryCatalog")));
      await until(() => status().includes(i18n.t("settings.sklm.remoteLoading")), `${locale}: skill retry did not announce loading`);
      await until(() => container.textContent?.includes("Recovered Skill") === true, `${locale}: skill did not load after retry`);
      await until(() => button(i18n.t("settings.sklm.retryCatalog")) !== undefined, `${locale}: partial skill failure has no retry`);
      click(button(i18n.t("settings.sklm.retryCatalog")));
      await until(() => skillCalls === 3 && !container.textContent?.includes("obra/superpowers"), `${locale}: second skill retry did not clear partial failure`);

      flushSync(() => root.render(<div />));
      let mcpCalls = 0;
      api.searchMcpMarketRegistry = async () => {
        mcpCalls += 1;
        if (mcpCalls === 1) return { entries: [], failedSources: ["official registry"] };
        if (mcpCalls === 2) return { entries: [mcpEntry], failedSources: ["community catalog"] };
        return { entries: [mcpEntry], failedSources: [] };
      };
      render("mcp");
      await until(() => status().includes(i18n.t("settings.mcpMarket.remoteError")), `${locale}: MCP market error status missing`);
      click(button(i18n.t("settings.mcpMarket.retry")));
      await until(() => status().includes(i18n.t("settings.mcpMarket.remoteLoading")), `${locale}: MCP retry did not announce loading`);
      await until(() => container.textContent?.includes("Recovered Server") === true, `${locale}: MCP entry did not load after retry`);
      await until(() => button(i18n.t("settings.mcpMarket.retry")) !== undefined, `${locale}: partial MCP failure has no retry`);
      click(button(i18n.t("settings.mcpMarket.retry")));
      await until(() => mcpCalls === 3 && !container.textContent?.includes("community catalog"), `${locale}: second MCP retry did not clear partial failure`);
    }
    return { ok: true };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
};
