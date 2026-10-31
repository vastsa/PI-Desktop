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
  var marketSnapshotStage: (stage: string) => Promise<unknown>;
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

let i18n: ReturnType<typeof createInstance>;
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/** Drop the current mount point so the next `boot()` starts from an empty page. */
function teardown() {
  if (root) {
    flushSync(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
}

async function boot() {
  // Stages run one after another in the same window, and a viewport capture
  // shows whatever sits at the top of the page — a leftover container would
  // make every screenshot show the first stage's panel.
  teardown();
  if (!i18n) {
    i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
    });
  }
  api.getSettings = async () => structuredClone(settings);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

function mount(panel: "skill" | "mcp") {
  flushSync(() => root!.render(<div />));
  flushSync(() =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        {panel === "skill" ? (
          <SkillMarketPanel installedIds={[]} onBack={() => {}} onInstalled={() => {}} />
        ) : (
          <McpMarketPanel level="global" installedIds={[]} onBack={() => {}} onInstalled={() => {}} />
        )}
      </I18nextProvider>,
    ),
  );
}

const click = (element: HTMLElement | undefined | null) => {
  assert(element, "missing retry button");
  flushSync(() => element!.click());
};
const button = (label: string) =>
  [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
const status = () => container!.querySelector<HTMLElement>('[role="status"]')?.textContent ?? "";
const snapshotLine = () =>
  container!.querySelector<HTMLElement>(".sklm-status.is-snapshot, .mcpm-status.is-snapshot");
const typeSearch = (value: string) => {
  const input = container!.querySelector<HTMLInputElement>(".sklm-search-input, .mcpm-search-input");
  assert(input, "missing search input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

globalThis.marketRetryProbe = async () => {
  await boot();
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
      mount("skill");
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

      // --- Snapshot behavior: the last successful list survives a later failure.
      let snapCalls = 0;
      api.searchSkillMarket = async () => {
        snapCalls += 1;
        if (snapCalls === 1) return { entries: [skillEntry], failedSources: ["obra/superpowers"] };
        if (snapCalls === 2) return { entries: [], failedSources: ["anthropics/skills", "obra/superpowers"] };
        return { entries: [skillEntry], failedSources: [] };
      };
      mount("skill");
      await until(() => snapCalls === 1 && container.textContent?.includes("Recovered Skill") === true, `${locale}: snapshot run 1 did not load`);
      assert(!snapshotLine(), `${locale}: snapshot line shown before any failure`);
      click(button(i18n.t("settings.sklm.retryCatalog")));
      await until(
        () => status().includes(i18n.t("settings.sklm.remoteError")) || status().includes(i18n.t("settings.sklm.remoteErrorQuery")),
        `${locale}: snapshot run 2 did not fail`,
      );
      assert(snapshotLine(), `${locale}: failure with a snapshot shows no snapshot line`);
      assert(container.textContent?.includes("Recovered Skill") === true, `${locale}: retained list is missing after failure`);
      assert(button(i18n.t("settings.sklm.retryCatalog")), `${locale}: retained failure lost its retry`);
      click(button(i18n.t("settings.sklm.retryCatalog")));
      await until(() => snapCalls === 3 && !snapshotLine(), `${locale}: recovery kept the snapshot line`);

      // A snapshot answers its own query only: a different search that fails
      // must not be covered by results taken for another one.
      let mismatchCalls = 0;
      api.searchSkillMarket = async () => {
        mismatchCalls += 1;
        if (mismatchCalls === 1) return { entries: [skillEntry], failedSources: [] };
        return { entries: [], failedSources: ["anthropics/skills"] };
      };
      mount("skill");
      await until(() => mismatchCalls === 1 && container.textContent?.includes("Recovered Skill") === true, `${locale}: mismatch run 1 did not load`);
      typeSearch("zzz");
      await until(() => mismatchCalls === 2, `${locale}: mismatch query was never sent`);
      await until(() => status().includes(i18n.t("settings.sklm.remoteError")), `${locale}: mismatch query did not fail`);
      assert(!snapshotLine(), `${locale}: a snapshot for another query covered this one`);

      // A fresh failure with nothing to fall back to stays as before: no line.
      let bareCalls = 0;
      api.searchSkillMarket = async () => {
        bareCalls += 1;
        return { entries: [], failedSources: ["anthropics/skills"] };
      };
      mount("skill");
      await until(() => bareCalls === 1 && status().includes(i18n.t("settings.sklm.remoteError")), `${locale}: bare failure did not render`);
      assert(!snapshotLine(), `${locale}: empty first failure claimed a snapshot`);

      flushSync(() => root.render(<div />));
      let mcpCalls = 0;
      api.searchMcpMarketRegistry = async () => {
        mcpCalls += 1;
        if (mcpCalls === 1) return { entries: [], failedSources: ["official registry"] };
        if (mcpCalls === 2) return { entries: [mcpEntry], failedSources: ["community catalog"] };
        return { entries: [mcpEntry], failedSources: [] };
      };
      mount("mcp");
      await until(() => status().includes(i18n.t("settings.mcpMarket.remoteError")), `${locale}: MCP market error status missing`);
      click(button(i18n.t("settings.mcpMarket.retry")));
      await until(() => status().includes(i18n.t("settings.mcpMarket.remoteLoading")), `${locale}: MCP retry did not announce loading`);
      await until(() => container.textContent?.includes("Recovered Server") === true, `${locale}: MCP entry did not load after retry`);
      await until(() => button(i18n.t("settings.mcpMarket.retry")) !== undefined, `${locale}: partial MCP failure has no retry`);
      click(button(i18n.t("settings.mcpMarket.retry")));
      await until(() => mcpCalls === 3 && !container.textContent?.includes("community catalog"), `${locale}: second MCP retry did not clear partial failure`);

      // MCP snapshot: same contract as the skill market.
      let mcpSnap = 0;
      api.searchMcpMarketRegistry = async () => {
        mcpSnap += 1;
        if (mcpSnap === 1) return { entries: [mcpEntry], failedSources: ["community catalog"] };
        if (mcpSnap === 2) return { entries: [], failedSources: ["official registry"] };
        return { entries: [mcpEntry], failedSources: [] };
      };
      mount("mcp");
      await until(() => mcpSnap === 1 && container.textContent?.includes("Recovered Server") === true, `${locale}: MCP snapshot run 1 did not load`);
      click(button(i18n.t("settings.mcpMarket.retry")));
      await until(() => status().includes(i18n.t("settings.mcpMarket.remoteError")), `${locale}: MCP snapshot run 2 did not fail`);
      assert(snapshotLine(), `${locale}: MCP failure with a snapshot shows no snapshot line`);
      assert(container.textContent?.includes("Recovered Server") === true, `${locale}: MCP retained list is missing`);
      assert(
        container.querySelector(".mcpm-badge.is-remote"),
        `${locale}: retained MCP entry lost its remote source badge`,
      );
    }
    return { ok: true };
  } finally {
    teardown();
  }
};

/**
 * One state per call, for review screenshots: `error-with-snapshot`,
 * `retry-loading`, `error-no-snapshot`, `recovered`. Renders with zh-CN, the
 * locale the reviewer reads, and leaves the state painted when it resolves.
 */
globalThis.marketSnapshotStage = async (stage: string) => {
  await boot();
  await i18n.changeLanguage("zh-CN");
  const skillCalls = { count: 0 };
  let pending: ((value: unknown) => void) | null = null;
  api.searchSkillMarket = async () => {
    skillCalls.count += 1;
    if (stage === "error-no-snapshot") {
      return { entries: [], failedSources: ["anthropics/skills", "obra/superpowers"] };
    }
    if (skillCalls.count === 1) {
      return { entries: [skillEntry], failedSources: ["obra/superpowers"] };
    }
    if (stage === "retry-loading" && skillCalls.count === 3) {
      // Third call hangs: the retry is in flight while the snapshot shows.
      return new Promise((resolve) => {
        pending = resolve;
      });
    }
    if (stage === "recovered" && skillCalls.count === 3) {
      // Second call fails (snapshot keeps the list), third recovers.
      return { entries: [skillEntry], failedSources: [] };
    }
    return { entries: [], failedSources: ["anthropics/skills", "obra/superpowers"] };
  };
  mount("skill");
  if (stage === "error-no-snapshot") {
    await until(() => status().includes(i18n.t("settings.sklm.remoteError")), "no-snapshot error missing");
  } else {
    await until(() => container.textContent?.includes("Recovered Skill") === true, `${stage}: first load missing`);
  }
  if (stage === "error-with-snapshot" || stage === "retry-loading") {
    click(button(i18n.t("settings.sklm.retryCatalog")));
    await until(() => status().includes(i18n.t("settings.sklm.remoteError")), `${stage}: failure missing`);
  }
  if (stage === "retry-loading") {
    click(button(i18n.t("settings.sklm.retryCatalog")));
    await until(() => status().includes(i18n.t("settings.sklm.remoteLoading")), "retry-loading state missing");
  }
  if (stage === "recovered") {
    click(button(i18n.t("settings.sklm.retryCatalog")));
    await until(() => status().includes(i18n.t("settings.sklm.remoteError")), "recovered: failure missing");
    click(button(i18n.t("settings.sklm.retryCatalog")));
    await until(() => !snapshotLine() && container.textContent?.includes("Recovered Skill") === true, "recovered: list missing");
  }
  await painted();
  return { ok: true, stage, pending: pending !== null };
};
