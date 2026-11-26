import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { pluginWorkPanelTab, toolWorkPanelTab } from "../../apps/desktop/src/lib/work-panel-tabs";
import { switchWorkPanelSession } from "../../apps/desktop/src/stores/slices/work-panel-slice";

/*
  #2607 — the bundled file manager is one live view shared by a project, so every
  session of that project must carry a real file-manager tab without the user
  opening one, while a session that closed it locally keeps it closed.
  Real WorkPanel, real store, real launcher rows, production session projection.
  Only the native bridge is inert: no guest-page or scroll-state claims here.
*/

const VIEW_REF = "pi.file-manager/manager";
const FM = pluginWorkPanelTab("pi.file-manager", "manager");
const REVIEW = toolWorkPanelTab("review");
const VIEW_META = { pluginId: "pi.file-manager", viewId: "manager", ref: VIEW_REF, title: "Files", pluginName: "PI-Desktop", order: 0 };

declare global {
  var fileManagerProjectTabProbe: () => Promise<{ ok: true; checks: string[] }>;
}

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
};

const host = document.createElement("div");
host.style.cssText = "position:absolute;left:0;top:0;width:1400px;height:820px;display:flex";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const store = () => useAppStore.getState();
const strip = () => [...host.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")].map((node) => node.dataset.workPanelTabId);
const hasFileManagerTab = (sessionId: string) => store().workPanelContexts[sessionId]?.tabs.some((tab) => tab.id === FM.id) === true;

async function rendered(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function closeTab(tabId: string): void {
  const button = host.querySelector<HTMLElement>(`[data-work-panel-tab-id="${tabId}"] .work-panel-tab-close`);
  check(button, `no close control for tab ${tabId}`);
  flushSync(() => button.click());
}
/** Production projection swap: what selecting a session does to the work panel. */
function switchTo(sessionId: string): void {
  flushSync(() => useAppStore.setState((state) => ({ ...switchWorkPanelSession(state, sessionId), activeSessionId: sessionId })));
}
function openPanel(): void {
  flushSync(() => store().openWorkPanel());
}

export async function runFileManagerProjectTabProbe() {
  await ready;
  const checks: string[] = [];
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "session-a",
      sessions: ["a", "b", "c", "d"].map((id) => ({
        id: `session-${id}`, title: id, projectPath: id === "d" ? "/other" : "/project",
        mode: "agent", permissionMode: "inherit", thinkingLevel: "off",
        createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 0,
      })),
      workPanelWidth: 520,
      workPanelOpen: false,
      workPanelTabs: [],
      activeWorkPanelTabId: null,
      workPanelFileRequest: null,
      // B was used before: review selected, panel collapsed, no file manager.
      workPanelContexts: { "session-b": { open: false, tabs: [REVIEW], activeTabId: REVIEW.id, fileRequest: null } },
      pluginViews: [VIEW_META],
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={1400} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
  await rendered();

  // A opens the bundled file manager from its launcher row (never the `+` tab).
  openPanel();
  await rendered();
  const launcherRow = host.querySelector<HTMLElement>(`[data-work-panel-launcher-item="${VIEW_REF}"]`);
  check(launcherRow, "the launcher row for the bundled file manager is missing");
  flushSync(() => launcherRow.click());
  await rendered();
  check(strip().includes(FM.id), "session A did not open the file manager");

  // B keeps its retained review selection and already carries the shared tab.
  switchTo("session-b");
  await rendered();
  check(store().workPanelContexts["session-b"]?.activeTabId === REVIEW.id, "session B lost its selected review tab");
  check(hasFileManagerTab("session-b"), "session B has no file-manager tab");
  check(store().workPanelOpen === false, "switching reopened session B's collapsed panel");
  openPanel();
  await rendered();
  check(store().activeWorkPanelTabId === REVIEW.id, "session B did not restore its review tab");
  check(strip().includes(FM.id) && strip().includes(REVIEW.id), "session B's strip lacks the file-manager tab");
  checks.push("a same-project session keeps its selected tab and already carries the file-manager tab");

  // Closing it locally is final for that session only.
  closeTab(FM.id);
  await rendered();
  check(!hasFileManagerTab("session-b"), "the closed file-manager tab stayed in session B");
  switchTo("session-a");
  await rendered();
  check(strip().includes(FM.id), "closing it in session B also closed session A's tab");
  switchTo("session-b");
  await rendered();
  check(!hasFileManagerTab("session-b") && !store().workPanelTabs.some((tab) => tab.id === FM.id),
    "the closed file-manager tab was reinserted in session B");
  checks.push("a local tab close removes it from that session and it is never reinserted");

  // After the last close, a fresh session of the project already has the tab.
  switchTo("session-a");
  await rendered();
  closeTab(FM.id);
  await rendered();
  check(!hasFileManagerTab("session-a"), "the last file-manager tab did not close");
  switchTo("session-c");
  await rendered();
  check(hasFileManagerTab("session-c"), "a fresh session in the project has no file-manager tab");
  check(store().workPanelOpen === false, "a fresh session opened the collapsed panel");
  openPanel();
  await rendered();
  check(strip().includes(FM.id), "opening the fresh session's panel hides the file-manager tab");
  check(store().activeWorkPanelTabId === FM.id, "the file-manager tab is not the active tab");
  checks.push("a fresh session of the project already has the file-manager tab, collapsed");

  // Another project is isolated.
  switchTo("session-d");
  await rendered();
  check(!hasFileManagerTab("session-d") && store().workPanelTabs.length === 0,
    "another project's session inherited the file-manager tab");
  checks.push("a session from another project has no file-manager tab");

  return { ok: true as const, checks };
}

globalThis.fileManagerProjectTabProbe = runFileManagerProjectTabProbe;
