// External preload transport is a fixture; renderer API, store and TodoDock are production code.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import type { SessionTodo, SessionTodoSnapshot } from "@pi-desktop/shared";
import { TodoDock } from "../../apps/desktop/src/components/TodoDock";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  interface Window {
    todoFixture: { action(name: string, input?: unknown): Promise<unknown> };
    todoChecklistProbe(): Promise<unknown>;
  }
}
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const root = createRoot(document.getElementById("root")!);
const unsubscribe = api.onTodosChanged(useAppStore.getState().applyTodosChanged);
const action = (name: string, input?: unknown) => window.todoFixture.action(name, input);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await frame();
  }
  await frame();
}
async function mount(sessionId: string) {
  flushSync(() => root.render(<TodoDock sessionId={sessionId} />));
  await frame();
}
const dock = () => document.querySelector(".todo-dock");
const header = () => document.querySelector<HTMLButtonElement>(".todo-dock-header");
const snapshot = (id: string) => useAppStore.getState().sessionTodos[id];
function items(count: number, prefix: string): SessionTodo[] {
  return Array.from({ length: count }, (_, index) => ({ content: `${prefix} ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending", priority: "medium" }));
}
async function write(sessionId: string, todos: SessionTodo[]) {
  return await action("write", { sessionId, todos }) as SessionTodoSnapshot & { toolResultText: string };
}
window.todoChecklistProbe = async () => {
  const checks: string[] = [];
  const first = await action("create", "Todo first") as string;
  const second = await action("create", "Todo second") as string;
  await mount(first);
  await until(() => snapshot(first)?.revision === 0, "Initial empty snapshot must recover");
  assert(!dock(), "Empty session must hide the dock");

  const original = await write(first, items(10, "Task"));
  await until(() => header()?.textContent?.includes("Task 1") === true, "Committed host notification must reach TodoDock");
  assert(header()?.getAttribute("aria-expanded") === "false", "Dock starts collapsed");
  flushSync(() => header()!.click());
  await until(() => header()?.getAttribute("aria-expanded") === "true", "Click must expand dock");
  assert(document.querySelectorAll(".todo-dock-row").length === 8, "Expanded list is capped at eight rows");
  assert(document.querySelector(".todo-dock-more")?.textContent?.includes("2"), "Overflow count must render");
  checks.push("agent-prompt-tool-discovery-host-write-event-dock-expand-bounded-list");
  const normalized = await write(first, [
    { content: "😀".repeat(501), status: "in_progress", priority: "high" },
    { content: "Second active item", status: "in_progress", priority: "medium" },
  ]);
  assert([...normalized.todos[0].content].length === 500, "Host must truncate 501 Unicode scalars to 500");
  assert(normalized.todos[1].status === "pending", "Host must keep only the first active item");
  assert(normalized.toolResultText.includes("truncated to 500 characters"), "Agent must receive host truncation warning");
  assert(normalized.toolResultText.includes("later ones became pending"), "Agent must receive normalization warning");
  await until(() => snapshot(first)?.revision === normalized.revision, "Normalized snapshot must reach production store");
  checks.push("agent-501-unicode-truncation-warning-single-active");
  await write(first, items(10, "Task"));

  await write(second, items(1, "Other"));
  await mount(second);
  await until(() => header()?.textContent?.includes("Other 1") === true, "Session switch must show its own checklist");
  assert(header()?.getAttribute("aria-expanded") === "false", "Session switch collapses dock");
  await mount(first);
  await until(() => header()?.textContent?.includes("Task 1") === true, "Returning session restores its checklist");
  checks.push("session-switch-isolation");

  const finished = await write(first, [
    { content: "Done", status: "completed", priority: "high" },
    { content: "Dropped", status: "cancelled", priority: "low" },
  ]);
  await until(() => snapshot(first)?.revision === finished.revision, "Completion must reach store");
  assert(header()?.textContent?.includes("1/1"), "Cancelled items are excluded from progress denominator");
  await action("event", original);
  await frame();
  assert(snapshot(first)?.revision === finished.revision, "Stale event cannot replace newer snapshot");
  assert(header()?.textContent?.includes("1/1"), "Stale event cannot replace finished UI");
  const cancelled = await write(first, [{ content: "Dropped", status: "cancelled", priority: "medium" }]);
  await until(() => snapshot(first)?.revision === cancelled.revision, "Cancellation must reach store");
  assert(header()?.textContent?.toLowerCase().includes("cancelled"), "All-cancelled list must show cancelled status");
  const cleared = await write(first, []);
  await until(() => snapshot(first)?.revision === cleared.revision && !dock(), "Clear must advance revision and hide dock");
  checks.push("complete-cancel-clear-stale-event");

  await action("suppressEvents", true);
  const durable = await write(first, items(1, "Persisted"));
  await action("restart");
  await action("suppressEvents", false);
  await action("ready");
  await until(() => snapshot(first)?.revision === durable.revision && header()?.textContent?.includes("Persisted 1") === true,
    "Host restart must recover a newer durable snapshot even with a cached empty snapshot");
  checks.push("sqlite-host-restart-cached-snapshot-recovery");

  const third = await action("create", "First-read failure") as string;
  await action("suppressEvents", true);
  const recoverable = await write(third, items(1, "Recovered"));
  await action("suppressEvents", false);
  const readsBefore = await action("readCount") as number;
  await action("failRead");
  await mount(third);
  await until(() => !dock(), "Unknown session snapshot must hide stale UI");
  await until(() => !snapshot(third), "Injected read failure must not fabricate state");
  assert(await action("readFailures") === 1, "The initial transport read failure must actually occur");
  // Explicit transport readiness is the sync point; no arbitrary timer delay.
  await action("ready");
  await until(() => snapshot(third)?.revision === recoverable.revision && header()?.textContent?.includes("Recovered 1") === true,
    "A failed first read must retry when the host becomes ready");
  assert((await action("readCount") as number) > readsBefore, "Recovery must use the real todos.get transport");
  checks.push("initial-read-failure-ready-recovery");

  const reads = await action("readCount") as number;
  await mount("remote:fixture");
  await frame();
  assert(!dock(), "Remote session must not show local checklist");
  assert(await action("readCount") === reads, "Remote session must skip local SQLite recovery");
  unsubscribe();
  flushSync(() => root.unmount());
  return { ok: true, checks, normalization: { unicodeScalars: [...normalized.todos[0].content].length,
    activeItems: normalized.todos.filter((todo) => todo.status === "in_progress").length,
    truncationWarning: normalized.toolResultText.includes("truncated to 500 characters"),
    demotionWarning: normalized.toolResultText.includes("later ones became pending") }, host: "real-stdio-sqlite", agent: "production-runtime-tool-search-todo-write", provider: "deterministic-event-stream-only", renderer: "production-todo-dock-api-store" };
};
