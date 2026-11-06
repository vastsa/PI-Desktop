import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { TaskDock } from "../../apps/desktop/src/components/TaskDock";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
let stops = 0;
Object.defineProperty(window, "piDesktop", { value: {
  invoke: async (channel: string) => {
    let data: unknown;
    if (channel === IPC.invoke.backgroundTasksList) {
      data = { tasks: [{ id: "task-1", sessionId: "fixture", command: "fixture-dev-server",
        commandShellId: "bash", state: "running", elapsedMs: 1000 }], version: 1 };
    } else if (channel === IPC.invoke.backgroundTasksOutput) {
      data = { id: "task-1", state: "running", stdout: "fixture log output", stderr: "", truncated: false };
    } else if (channel === IPC.invoke.todosGet) {
      data = useAppStore.getState().sessionTodos.fixture;
    } else if (channel === IPC.invoke.backgroundTasksStop) {
      stops++;
      data = { ok: true, found: true };
    } else throw new Error(`Unexpected fixture IPC: ${channel}`);
    return { ok: true, data };
  },
  on: () => () => {},
} });
function select(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((element) => element.textContent?.startsWith(label));
  assert(button, `Missing tab ${label}`);
  flushSync(() => button.click());
  assert(button.getAttribute("aria-selected") === "true", `Tab ${label} must be selected`);
}
function assertPanel(todo: boolean) {
  assert(!!document.querySelector(".todo-dock-list") === todo, "Todo panel visibility mismatch");
  assert(!!document.querySelector(".task-list") === !todo, "Task panel visibility mismatch");
  assert(!!document.querySelector(".task-action.is-stop") === !todo, "Stop belongs only to Tasks");
  assert(document.querySelector(".dock-live")?.textContent === "1 running", "Live count must remain");
}
async function probe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const root = createRoot(document.getElementById("root")!);
  try {
    for (const status of ["in_progress", "completed"] as const) {
      flushSync(() => useAppStore.setState({ sessionTodos: { fixture: {
        sessionId: "fixture", revision: 1, updatedAt: 1,
        todos: [{ content: "fixture checklist item", status, priority: "high" }],
      } } }));
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><TaskDock sessionId="fixture" /></I18nextProvider>));
      await until(() => document.querySelectorAll('[role="tab"]').length === 2, "Task tabs must load");
      select("Todo");
      assertPanel(true);
      assert(!document.querySelector(".task-output"), "Todo must not show a log");
      select("Background tasks");
      assertPanel(false);
      const row = document.querySelector<HTMLElement>(".task-main");
      assert(row, "Task row missing");
      if (row.getAttribute("aria-expanded") !== "true") flushSync(() => row.click());
      await until(() => !!document.querySelector("pre")?.textContent?.includes("fixture log output"), "Log must load");
      select("Todo");
      assertPanel(true);
      assert(!document.querySelector("pre"), "Task log must not leak into Todo");
      select("Background tasks");
      assertPanel(false);
      assert(document.querySelector("pre")?.textContent?.includes("fixture log output"), "Open log must survive switching");
    }
    assert(stops === 0, "Switching tabs must never stop a task");
    return { ok: true, scenarios: 2 };
  } finally { flushSync(() => root.unmount()); }
}
Object.assign(globalThis, { taskDockTabsProbe: probe });
