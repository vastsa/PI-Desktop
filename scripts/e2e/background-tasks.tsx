import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { BackgroundTasksBar } from "../../apps/desktop/src/components/BackgroundTasksBar";
import { TodoDock } from "../../apps/desktop/src/components/TodoDock";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { BackgroundTaskOutput, BackgroundTaskSummary } from "../../apps/desktop/src/lib/api";

const listeners = new Set<() => void>();
const requests: string[] = [];
const pending = new Map<string, (value: BackgroundTaskOutput) => void>();
let tasks: BackgroundTaskSummary[] = [];
let revision = 0;
let deferOutput = false;
let rejectStop = false;
let root: Root | undefined;

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert(performance.now() < deadline, label);
    await frame();
  }
}

function output(id: string): BackgroundTaskOutput {
  return {
    id, state: "running", truncated: true,
    stdout: `${"*".repeat(256 * 1024 - 100)}\n${id}: output revision ${revision}`,
    stderr: "*".repeat(256 * 1024),
  };
}

Object.defineProperty(window, "piDesktop", {
  value: {
    invoke: async (channel: string, payload?: { id: string }) => {
      const call = async () => {
        if (channel === IPC.invoke.backgroundTasksList) return { tasks: [...tasks], version: revision };
        if (channel === IPC.invoke.backgroundTasksOutput) {
          const id = payload!.id;
          requests.push(id);
          if (deferOutput) return new Promise<BackgroundTaskOutput>((resolve) => pending.set(id, resolve));
          return output(id);
        }
        if (channel === IPC.invoke.backgroundTasksStop) {
          if (rejectStop) throw new Error("Fixture stop failure");
          tasks = tasks.map((task) => task.id === payload!.id ? { ...task, state: "stopped" } : task);
          for (const listener of listeners) listener();
          return { ok: true, found: true };
        }
        if (channel === IPC.invoke.todosGet) return useAppStore.getState().sessionTodos["fixture"];
        throw new Error(`Unexpected fixture IPC: ${channel}`);
      };
      return { ok: true, data: await call() };
    },
    on: (channel: string, listener: () => void) => {
      if (channel !== IPC.event.backgroundTasksChanged) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
});

async function mount(count = 10) {
  flushSync(() => root?.unmount());
  pending.clear();
  requests.length = 0;
  revision = 0;
  deferOutput = false;
  rejectStop = false;
  tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`, sessionId: "fixture",
    command: `node output-fixture.mjs --task=${index} ${"long-command-".repeat(8)}`,
    commandShellId: "bash", state: "running", elapsedMs: 1_000,
  }));
  document.body.innerHTML = '<main id="root"></main>';
  useAppStore.setState({
    activeSessionId: "fixture",
    sessionTodos: {
      fixture: {
        sessionId: "fixture", revision: 1, updatedAt: 1,
        todos: [{ content: "Verify background commands", status: "in_progress", priority: "medium" }],
      },
    },
  });
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(
    <I18nextProvider i18n={i18n}>
      <div className="composer-dock composer-dock-docked">
        <div className="composer-stack">
          <TodoDock sessionId="fixture" />
          <BackgroundTasksBar />
          <AskToolCard request={{
            sessionId: "fixture", requestId: "fixture-ask", toolCallId: "fixture-ask",
            questions: [{ question: "Keep the background commands running?", options: ["Continue", "Stop"] }],
          }} />
          <div className="composer-shell"><textarea aria-label="Fixture message" /></div>
        </div>
      </div>
    </I18nextProvider>,
  ));
  await until(() => document.querySelectorAll(".background-task").length === count, "tasks did not render");
}

function row(index: number) {
  const element = document.querySelectorAll<HTMLElement>(".background-task")[index];
  assert(element, `task ${index} must be reachable`);
  return element;
}

function click(index: number, label = "Output") {
  const button = [...row(index).querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.trim() === label);
  assert(button, `${label} control is missing`);
  flushSync(() => button.click());
}

async function probe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  let responsiveness: { samples: number; eventLoopDelayP95Ms: number; eventLoopDelayMaxMs: number; outputReads: number } | undefined;
  const unhandled: string[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandled.push(String(event.reason));
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  const check = async (name: string, run: () => Promise<void>) => {
    try { await run(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error) }); }
  };

  await check("ten tasks scroll without displacing Todo, Ask, or input", async () => {
    await mount();
    const bar = document.querySelector<HTMLElement>(".background-tasks-bar")!;
    const box = bar.getBoundingClientRect();
    assert(box.height >= 40, `task list must be visible (${box.height}px)`);
    assert(box.height <= 220, `task list is unbounded (${box.height}px)`);
    assert(bar.scrollHeight > bar.clientHeight, "overflowing rows need an internal scrollport");
    assert(getComputedStyle(bar).overflowY === "auto", "task list must be scrollable");
    const todo = document.querySelector(".todo-dock")!.getBoundingClientRect();
    const ask = document.querySelector(".asktool-card")!.getBoundingClientRect();
    const input = document.querySelector("textarea")!.getBoundingClientRect();
    assert(todo.top >= 0 && todo.bottom <= box.top + 1, "Todo must remain above the task list");
    assert(box.bottom <= ask.top + 1 && ask.bottom <= input.top + 1, "Ask must remain above the input");
    assert(input.bottom <= innerHeight && input.width > 100, "input must remain usable");
    row(9).scrollIntoView({ block: "nearest" });
    click(9);
    await until(() => !!document.querySelector(".background-task-output")?.textContent?.includes("task-9"), "last task output is unreachable");
  });

  await check("only the selected log refreshes and remains bounded", async () => {
    await mount();
    assert(requests.length === 0, "collapsed logs must not cross IPC");
    click(0);
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 0"), "initial output is missing");
    revision = 1;
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 1"), "expanded output never refreshed");
    assert(requests.every((id) => id === "task-0"), "unselected output must not be fetched");
    assert(document.querySelector("pre")!.textContent!.length <= 12_010, "rendered output must stay bounded");
  });

  await check("late output cannot replace the newly selected task", async () => {
    await mount();
    deferOutput = true;
    click(0);
    await until(() => pending.has("task-0"), "first output request is missing");
    click(1);
    await until(() => pending.has("task-1"), "second output request is missing");
    pending.get("task-1")!(output("task-1"));
    await until(() => !!document.querySelector("pre")?.textContent?.includes("task-1"), "second output is missing");
    pending.get("task-0")!(output("task-0"));
    await frame();
    await frame();
    assert(document.querySelector("pre")?.textContent?.includes("task-1"), "late first response erased the current output");
  });

  await check("Stop failures are visible and retryable", async () => {
    await mount();
    rejectStop = true;
    click(0, "Stop");
    await until(() => !!document.querySelector('[role="alert"]'), "Stop failure must be visible");
    rejectStop = false;
    click(0, "Stop");
    await until(() => row(0).dataset.state === "stopped", "Stop retry did not settle");
    assert(unhandled.length === 0, `unhandled rejection: ${unhandled.join(", ")}`);
  });

  await check("typing remains responsive with ten tasks and a full output preview", async () => {
    await mount();
    click(0);
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 0"), "output is missing");
    const input = document.querySelector("textarea")!;
    input.focus();
    const gaps: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 120; index++) {
      revision++;
      input.value = `message-${index}`;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(index) }));
      // A fixed-rate input workload measures event-loop delay independently
      // of compositor frame suppression in an intentionally hidden window.
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      const now = performance.now();
      gaps.push(Math.max(0, now - previous - 16));
      previous = now;
    }
    gaps.sort((a, b) => a - b);
    responsiveness = {
      samples: gaps.length,
      eventLoopDelayP95Ms: Number(gaps[Math.floor(gaps.length * 0.95)].toFixed(2)),
      eventLoopDelayMaxMs: Number(gaps.at(-1)!.toFixed(2)),
      outputReads: requests.length,
    };
    assert(input.value === "message-119", "typing must remain usable");
    assert(responsiveness.eventLoopDelayP95Ms < 250, "background polling must not stall the renderer");
    assert(requests.every((id) => id === "task-0"), "only the open output may be polled");
  });

  flushSync(() => root?.unmount());
  await frame();
  assert(listeners.size === 0, "unmount must detach the background task listener");
  await mount();
  await frame();
  await frame();
  window.removeEventListener("unhandledrejection", onUnhandled);
  return { viewport: { width: innerWidth, height: innerHeight }, results, responsiveness, ok: results.every((result) => result.ok) };
}

Object.assign(globalThis, { backgroundTasksProbe: probe });
