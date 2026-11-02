import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

type Scenario = {
  count: number;
  width: number;
  height: number;
  explicitTab: boolean;
  theme: "light" | "dark";
  language: "en" | "zh-CN";
};

declare global {
  var launcherOverflowProbe: (scenario: Scenario) => Promise<{
    ok: true;
    rows: number;
    scrollHeight: number;
    clientHeight: number;
  }>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Mock only the native bridge; the real component, store actions, and CSS run.
window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
};
const host = document.createElement("div");
host.style.cssText = "position:absolute;inset:0 auto auto 0;display:flex";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: {
    en: { translation: catalogs.en },
    "zh-CN": { translation: catalogs["zh-CN"] },
  },
  interpolation: { escapeValue: false },
});

function element(selector: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(selector);
  check(node, `Missing ${selector}`);
  return node;
}

async function rendered() {
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function visibleRow(row: HTMLElement, list: HTMLElement) {
  const box = row.getBoundingClientRect();
  const viewport = list.getBoundingClientRect();
  check(box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1,
    "Tool row is not fully visible inside its scroll viewport");
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  check(hit && row.contains(hit), "Visible tool does not receive pointer hits");
}

globalThis.launcherOverflowProbe = async (scenario) => {
  await ready;
  await i18n.changeLanguage(scenario.language);
  document.documentElement.dataset.theme = scenario.theme;
  host.style.width = `${scenario.width}px`;
  host.style.height = `${scenario.height}px`;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "launcher-overflow",
      workPanelWidth: scenario.width,
      workPanelOpen: true,
      workPanelTabs: [],
      activeWorkPanelTabId: null,
      workPanelContexts: {},
      pluginViews: Array.from({ length: scenario.count }, (_, order) => ({
        pluginId: `fixture.tool-${order}`,
        viewId: "main",
        ref: `fixture.tool-${order}/main`,
        title: `${scenario.language === "en" ? "Tool" : "工具"} ${order} ${"Long localized tool name ".repeat(8)}`,
        pluginName: `Fixture ${order}`,
        order,
      })),
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={scenario.width + 450} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
  if (scenario.explicitTab) {
    flushSync(() => element(".work-panel-new-tab").click());
  }
  await rendered();

  const list = element(".work-panel-launcher-list");
  const title = element(".work-panel-launcher-title");
  const rows = [...host.querySelectorAll<HTMLElement>(".work-panel-launcher-row")];
  const first = rows[0];
  const last = rows.at(-1);
  check(first && last, "Review row is missing");
  check(rows.length === scenario.count + 1, "Launcher lost or duplicated a tool");
  const body = element(".work-panel-body").getBoundingClientRect();
  const launcher = element(".work-panel-launcher").getBoundingClientRect();
  check(launcher.top >= body.top - 1 && launcher.bottom <= body.bottom + 1,
    "Launcher grows outside the panel body");
  check(list.scrollWidth === list.clientWidth, "Long labels create horizontal scrolling");
  for (const row of rows) {
    check(row.getBoundingClientRect().height === 40, "Tool hit targets were compressed");
  }
  const overflows = rows.length * 40 + (rows.length - 1) * 2 > list.clientHeight;
  check((list.scrollHeight > list.clientHeight) === overflows,
    "The tool list does not own vertical overflow");
  const thumb = getComputedStyle(list, "::-webkit-scrollbar-thumb").backgroundColor;
  check(!["rgba(0, 0, 0, 0)", "transparent"].includes(thumb) && !/\s0\)$/.test(thumb),
    "The tool list hides its scroll affordance at rest");
  const titleTop = title.getBoundingClientRect().top;
  list.scrollTop = list.scrollHeight;
  await rendered();
  visibleRow(last, list);
  check(title.getBoundingClientRect().top === titleTop, "Scrolling moves the launcher title");

  // Browser focus must reveal off-screen rows without moving the panel shell.
  first.focus();
  await rendered();
  visibleRow(first, list);
  last.focus();
  await rendered();
  visibleRow(last, list);
  check(title.getBoundingClientRect().top === titleTop, "Keyboard focus moves the launcher title");
  check(host.scrollHeight <= host.clientHeight, "Tool navigation scrolls the outer shell");

  const result = { ok: true as const, rows: rows.length,
    scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  if (scenario.count > 0) {
    const sourceTabId = useAppStore.getState().activeWorkPanelTabId;
    flushSync(() => last.click());
    await rendered();
    const state = useAppStore.getState();
    const destination = state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId);
    check(destination?.resource === `fixture.tool-${scenario.count - 1}/main`,
      "The last tool does not open its own view");
    check(state.workPanelTabs.length === 1 && destination.id !== sourceTabId,
      "Opening a tool failed to replace the New launcher");
    flushSync(() => element(".work-panel-tab-close").click());
    await rendered();
    check(host.querySelectorAll(".work-panel-launcher-row").length === rows.length,
      "Closing the view did not restore all tools");
    check(useAppStore.getState().workPanelOpen, "Closing the final view collapsed the panel");
  }
  return result;
};
