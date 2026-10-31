import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * What the shared container shows once a task is over.
 *
 * host-core keeps a finished task in its registry so its output stays readable
 * and the renderer can show the exit code for the grace window; the entry is
 * not deleted when the row leaves the container. The container must therefore
 * answer to the rows it can render, never to the registry's full session list —
 * otherwise a stopped or self-exited command leaves a permanent
 * "1 background tasks" header with no row to stop, dismiss, or read.
 *
 * Rendered through the real container, store, and locale with the task data
 * layer stubbed, so the assertion is what the user actually sees.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = fileURLToPath(new URL("./helpers/background-tasks-hook.stub.ts", import.meta.url));

const task = (id, state, exitCode) => ({
  id,
  sessionId: "session-dock-render",
  command: `pnpm dev ${id}`,
  commandShellId: "pwsh",
  state,
  elapsedMs: 2_000,
  ...(exitCode === undefined ? {} : { exitCode }),
});

async function withDockRender(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        // The registry read is the container's data source; stub it only.
        name: "background-tasks-hook-stub",
        enforce: "pre",
        resolveId(source) {
          return source.endsWith("background-tasks/useBackgroundTasks") ? HOOK : null;
        },
      },
    ],
  });
  try {
    const { TaskDock } = await server.ssrLoadModule("/src/components/TaskDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (fixture) => {
      const sessionId = "session-dock-render";
      // The checklist side is the only other content the container can show.
      const snapshot = fixture.todos
        ? { sessionId, revision: 1, updatedAt: 1, todos: fixture.todos }
        : undefined;
      Object.assign(useAppStore.getInitialState(), {
        sessionTodos: snapshot ? { [sessionId]: snapshot } : {},
      });
      globalThis.__piDockFixture = fixture;
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TaskDock, { sessionId: "session-dock-render" }),
        ),
      );
    };
    await run({ render });
  } finally {
    delete globalThis.__piDockFixture;
    await server.close();
  }
}

test("the container disappears with its last row, even though the host still lists the finished task", async () => {
  await withDockRender(({ render }) => {
    const finished = task("t-stopped", "stopped");
    const html = render({ tasks: [], sessionTasks: [finished] });
    assert.equal(
      html,
      "",
      "a task the container can no longer render must not keep the container — or a task count — on screen",
    );
  });
});

test("registry history alone never keeps a header, even with several finished tasks", async () => {
  await withDockRender(({ render }) => {
    const html = render({
      tasks: [],
      sessionTasks: [task("t-1", "exited", 0), task("t-2", "failed", 1), task("t-3", "stopped")],
    });
    assert.equal(html, "");
  });
});

test("the container counts the rows it can render", async () => {
  await withDockRender(({ render }) => {
    const running = task("t-running", "running");
    const html = render({ tasks: [running], sessionTasks: [running, task("t-old", "exited", 0)] });
    assert.match(html, /class="dock/);
    assert.match(html, /1 background tasks/, "the header counts the renderable row");
    assert.match(html, /1 running/);
    assert.match(html, /pnpm dev t-running/);
    assert.doesNotMatch(
      html,
      /pnpm dev t-old/,
      "a row the container may not render must not appear",
    );
  });
});

test("a finished row inside its grace window still counts", async () => {
  await withDockRender(({ render }) => {
    const finished = task("t-grace", "exited", 0);
    const html = render({ tasks: [finished], sessionTasks: [finished, task("t-hidden", "stopped")] });
    assert.match(html, /1 background tasks/);
    assert.doesNotMatch(html, /running/, "a finished row raises no live count");
    assert.match(html, /pnpm dev t-grace/);
  });
});

test("a checklist keeps the container without inventing an empty task panel", async () => {
  await withDockRender(({ render }) => {
    const html = render({
      tasks: [],
      sessionTasks: [task("t-stopped", "stopped")],
      todos: [{ content: "ship the dock fix", status: "in_progress", priority: "high" }],
    });
    assert.match(html, /class="todo-dock-list"/);
    assert.match(html, /ship the dock fix/);
    assert.doesNotMatch(html, /class="task-list"/, "no renderable row means no task panel");
    assert.doesNotMatch(
      html,
      /role="tablist"/,
      "tabs appear only while both sides have content",
    );
  });
});
