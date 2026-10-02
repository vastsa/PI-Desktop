import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const ORIGIN = {
  taskId: "task-a",
  taskTitle: "Nightly dependency check",
  runId: "run-completed",
  sessionId: "session-completed",
};

async function withVite(work) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

/**
 * Renders the topbar the way the shell does, through the real catalog and the
 * store's own initial state.
 */
async function renderTopbar(server, session, locale = "en") {
  const { ConversationTopbar } = await server.ssrLoadModule(
    "/src/components/ConversationTopbar.tsx",
  );
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  Object.assign(useAppStore.getInitialState(), {
    activeSessionId: session.id,
    sessions: [session],
    workspace: { path: "/project", name: "Project" },
  });
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ConversationTopbar, {
        sidebarCollapsed: false,
        workPanelOpen: false,
        onToggleSidebar() {},
        onNewTask() {},
        onOpenSearch() {},
      }),
    ),
  );
}

test("a scheduled run's conversation remembers the row it was opened from", async () => {
  await withVite(async (server) => {
    const returns = await server.ssrLoadModule("/src/features/scheduled/scheduled-return.ts");

    assert.equal(returns.peekScheduledReturn(), null, "nothing is remembered up front");
    assert.equal(returns.scheduledReturnFor("session-completed"), null);

    returns.rememberScheduledReturn(ORIGIN);
    assert.deepEqual(returns.peekScheduledReturn(), ORIGIN);
    assert.deepEqual(returns.peekScheduledReturn(), ORIGIN, "peeking never consumes the origin");

    assert.deepEqual(returns.scheduledReturnFor("session-completed"), ORIGIN);
    assert.equal(
      returns.scheduledReturnFor("session-unrelated"),
      null,
      "unrelated conversations never offer this task",
    );
    assert.equal(returns.scheduledReturnFor(null), null);
    assert.equal(returns.scheduledReturnFor(undefined), null);

    const back = [{ page: "chat" }, { page: "scheduled" }, { page: "chat" }];
    assert.equal(returns.scheduledReturnUsesHistory(back, 2), true, "the row behind is the route");
    assert.equal(returns.scheduledReturnUsesHistory(back, 1), false, "the route itself is not back");
    assert.equal(
      returns.scheduledReturnUsesHistory([{ page: "chat" }, { page: "chat" }], 1),
      false,
      "a conversation reached from elsewhere opens the route directly",
    );
    assert.equal(returns.scheduledReturnUsesHistory([], 0), false);
    assert.equal(returns.scheduledReturnUsesHistory(back, 3), false, "past the stack's end");
  });
});

test("the topbar offers the way back only for a scheduled run's conversation", async () => {
  await withVite(async (server) => {
    const returns = await server.ssrLoadModule("/src/features/scheduled/scheduled-return.ts");
    const automation = {
      id: "session-completed",
      title: "Nightly dependency check",
      scheduledRun: true,
    };

    returns.rememberScheduledReturn(ORIGIN);
    const withOrigin = await renderTopbar(server, automation);
    assert.match(withOrigin, /class="ct-back"/);
    assert.match(withOrigin, /data-nav="back-to-scheduled"/);
    assert.match(withOrigin, /<span class="ct-back-label">Scheduled<\/span>/);
    assert.match(withOrigin, /aria-label="Back to Scheduled"/);
    assert.match(
      withOrigin,
      /title="Back to Scheduled · Nightly dependency check"/,
      "hovering names the task the reader returns to",
    );

    returns.rememberScheduledReturn({ ...ORIGIN, sessionId: "session-other" });
    const unrelated = await renderTopbar(server, automation);
    const unrelatedRow = unrelated.match(/<button[^>]*ct-back[^>]*>/)?.[0] ?? "";
    assert.match(
      unrelatedRow,
      /title="Back to Scheduled"/,
      "without its own origin the row only names the destination",
    );
    assert.doesNotMatch(
      unrelatedRow,
      /Nightly dependency check/,
      "another conversation's task is never offered here",
    );

    const localized = await renderTopbar(server, automation, "zh-CN");
    assert.match(localized, /<span class="ct-back-label">定时任务<\/span>/);
    assert.match(localized, /aria-label="返回定时任务"/);

    const ordinary = await renderTopbar(server, { id: "session-plain", title: "Plain task" });
    assert.doesNotMatch(ordinary, /ct-back|back-to-scheduled/);
  });
});

test("the Scheduled route is the one that writes the return origin", async () => {
  const [pageSource, workspaceSource, topbarSource] = await Promise.all([
    read("../src/pages/ScheduledPage.tsx"),
    read("../src/features/scheduled/use-scheduled-workspace.ts"),
    read("../src/components/ConversationTopbar.tsx"),
  ]);

  assert.match(pageSource, /rememberScheduledReturn\(\{/);
  assert.match(pageSource, /taskTitle: selectedTask\.title/);
  assert.match(pageSource, /runId,/);
  assert.match(pageSource, /sessionId,/);

  assert.match(workspaceSource, /const restored = peekScheduledReturn\(\)/);
  assert.match(workspaceSource, /useState<string \| null>\(restored\?\.taskId \?\? null\)/);
  assert.match(workspaceSource, /useState<string \| null>\(restored\?\.runId \?\? null\)/);
  assert.match(
    workspaceSource,
    /resolveSelectedTaskId\(tasks, current, loaded\)/,
    "the restored task survives the first, still empty task list",
  );

  assert.match(topbarSource, /const scheduledSession = activeSession\?\.scheduledRun === true/);
  assert.match(topbarSource, /scheduledReturnUsesHistory\(navStack, navIndex\)/);
  assert.match(topbarSource, /navBack\(\);[\s\S]{0,80}else setPage\("scheduled"\)/);
});
