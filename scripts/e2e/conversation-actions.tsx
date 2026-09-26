// Real renderer components and store; only host-facing API methods are fixtures.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { api } from "../../apps/desktop/src/lib/api";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var conversationActionsProbe: () => Promise<unknown>;
}
window.addEventListener("error", (event) => console.error(event.error?.stack ?? event.message));
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
const date = "2026-01-01T00:00:00Z";
let records = ["alpha", "beta"].map((id) => ({
  id,
  title: id,
  projectPath: null,
  createdAt: date,
  updatedAt: date,
  messageCount: 0,
}));
const deleted: string[] = [];
api.renameSession = async (id, title) => {
  records = records.map((s) => (s.id === id ? { ...s, title } : s));
  return { ok: true };
};
api.deleteSession = async (id) => {
  deleted.push(id);
  records = records.filter((s) => s.id !== id);
  return { ok: true };
};
api.listSessions = async () => ({ sessions: records });
api.getSession = async (id) => ({
  session: { ...records.find((s) => s.id === id)!, messages: [] },
});
api.pendingPlans = async () => ({ plans: [] });
useAppStore.setState({
  sessions: records,
  activeSessionId: "alpha",
  workspace: null,
  activeProjectPath: null,
  openProjectPaths: [],
  openProjects: [],
  projectMeta: {},
  sessionMeta: {},
  runningSessions: {},
  sessionView: { sort: "recent", archived: false },
  page: "chat",
});
function Fixture() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <I18nextProvider i18n={i18n}>
      <button id="collapse" onClick={() => setCollapsed(!collapsed)}>
        Toggle test sidebar
      </button>
      <div style={{ display: "flex", height: "800px" }}>
        {!collapsed && (
          <Sidebar
            onToggleSidebar={() => setCollapsed(true)}
            sidebarToggleShortcut=""
            sidebarWidth={275}
            onWidthChange={() => {}}
            onWidthCommit={() => {}}
            onResizeCollapse={() => setCollapsed(true)}
          />
        )}
        <main style={{ flex: 1 }}>
          <ConversationTopbar
            sidebarCollapsed={collapsed}
            workPanelOpen={false}
            onToggleSidebar={() => setCollapsed(!collapsed)}
            onNewTask={() => {}}
            onOpenSearch={() => {}}
          />
          <textarea className="composer-input" aria-label="Composer" />
        </main>
      </div>
    </I18nextProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until<T>(read: () => T | null | false | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Timed out: ${label}`);
}
const action = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
async function click(name: string) {
  (await until(() => action(name), name)).click();
}
async function openHeader() {
  await click("conversation-menu");
  await until(
    () => document.querySelector(".conversation-actions-menu.is-open"),
    "header menu open",
  );
}
function escape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-sidebar-session-row="${id}"]`);
globalThis.conversationActionsProbe = async () => {
  await openHeader();
  const initialActions = [
    ...document.querySelectorAll(".conversation-actions-menu [data-action]"),
  ].map((n) => n.getAttribute("data-action"));
  await click("toggle-session-pin");
  await until(() => useAppStore.getState().sessionMeta.alpha?.pinned, "pinned current session");
  await until(
    () => row("alpha")?.closest('[data-sidebar-session-section="pinned"]'),
    "sidebar pin follows header",
  );
  check(document.activeElement === action("conversation-menu"), "pin returns focus to header");
  row("alpha")!.querySelector<HTMLButtonElement>('[data-action="session-menu"]')!.click();
  await until(
    () => action("toggle-session-pin")?.textContent?.includes("Unpin"),
    "sidebar observes pin",
  );
  const sidebarActions = [...document.querySelectorAll(".sidebar-row-menu [data-action]")].map(
    (n) => n.getAttribute("data-action"),
  );
  check(
    JSON.stringify(initialActions) === JSON.stringify(sidebarActions),
    "both entry points expose identical items",
  );
  await click("toggle-session-pin");
  await until(() => !useAppStore.getState().sessionMeta.alpha?.pinned, "sidebar unpin");
  // Header actions stay single-session even while two sidebar rows are selected.
  for (const id of ["alpha", "beta"]) {
    row(id)!
      .querySelector<HTMLButtonElement>(".thread-item-main")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await new Promise(requestAnimationFrame);
  }
  await openHeader();
  check(
    !action("batch-delete") && !!action("delete-session"),
    "header ignores sidebar multi-selection",
  );
  escape();
  await until(() => !action("delete-session"), "dismiss single-session menu");
  document.getElementById("collapse")!.click();
  await until(() => !row("alpha"), "sidebar unmounted");
  await openHeader();
  await click("rename-session");
  const input = await until(
    () => document.querySelector<HTMLInputElement>("#session-rename-input"),
    "rename input",
  );
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    input,
    "Release notes",
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(requestAnimationFrame);
  input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(
    () => document.querySelector(".ct-title")?.textContent === "Release notes",
    "header renamed",
  );
  await until(() => !document.querySelector('[role="dialog"]'), "rename closed");
  await openHeader();
  const menu = document.querySelector<HTMLElement>(".conversation-actions-menu")!;
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    const rect = menu.getBoundingClientRect();
    check(
      rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      `${theme} menu fits viewport`,
    );
  }
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  check(document.activeElement === action("rename-session"), "Home focuses first action");
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  check(document.activeElement === action("toggle-session-pin"), "ArrowDown advances focus");
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  check(document.activeElement === action("delete-session"), "End focuses final action");
  escape();
  await until(
    () => action("conversation-menu")?.getAttribute("aria-expanded") === "false",
    "Escape closes menu",
  );
  check(document.activeElement === action("conversation-menu"), "Escape restores trigger focus");
  await openHeader();
  await click("delete-session");
  await until(() => action("delete-session")?.dataset.armed === "true", "first click arms delete");
  check(deleted.length === 0, "first click cannot delete");
  escape();
  await until(() => !action("delete-session"), "dismiss armed menu");
  await openHeader();
  check(action("delete-session")?.dataset.armed === undefined, "reopening resets confirmation");
  useAppStore.setState({ activeSessionId: "beta" });
  await until(() => !action("delete-session"), "switch closes old menu");
  await openHeader();
  await click("toggle-session-pin");
  await until(() => useAppStore.getState().sessionMeta.beta?.pinned, "switch targets beta");
  check(!useAppStore.getState().sessionMeta.alpha?.pinned, "alpha unchanged after switch");
  useAppStore.setState({ runningSessions: { beta: true } });
  await openHeader();
  check(action("fork-session")?.disabled, "running session cannot fork");
  escape();
  await until(() => !action("fork-session"), "dismiss");
  useAppStore.setState({ runningSessions: {} });
  await openHeader();
  await click("toggle-session-archive");
  await until(() => useAppStore.getState().sessionMeta.beta?.archived, "archive beta");
  await until(
    () => useAppStore.getState().activeSessionId === "alpha",
    "archive selects same-scope replacement",
  );
  await openHeader();
  await click("delete-session");
  await until(() => action("delete-session")?.dataset.armed === "true", "delete armed");
  // Keep an unarchived replacement so this tests the existing selection flow.
  useAppStore.getState().restoreSession("beta");
  await new Promise(requestAnimationFrame);
  await click("delete-session");
  await until(() => deleted.includes("alpha"), "confirmed deletion reached host");
  await until(
    () => useAppStore.getState().activeSessionId === "beta",
    "delete selects replacement",
  );
  useAppStore.setState({ sessions: [{ ...records[0], source: "pi-native" }] });
  await openHeader();
  check(
    !action("rename-session") && !action("fork-session") && !action("delete-session"),
    "native session restrictions preserved",
  );
  check(
    !!action("toggle-session-pin") && !!action("toggle-session-archive"),
    "native organization available",
  );
  escape();
  await until(() => !action("toggle-session-pin"), "dismiss native menu");
  useAppStore.setState({ activeSessionId: undefined });
  await until(() => !action("conversation-menu"), "no actions without a session");
  return {
    ok: true,
    parity: true,
    collapsedSidebar: true,
    rename: true,
    pin: true,
    archive: true,
    deleteConfirmation: true,
    sessionSwitch: true,
    keyboard: true,
    sourceRestrictions: true,
  };
};
