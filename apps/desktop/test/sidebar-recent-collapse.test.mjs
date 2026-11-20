import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import {
  loadRecentSessionsCollapsed,
  saveRecentSessionsCollapsed,
  SIDEBAR_RECENT_COLLAPSED_KEY,
} from "../src/lib/sidebar-preferences.ts";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

async function withStorage(run) {
  const previous = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    return await run(storage);
  } finally {
    globalThis.localStorage = previous;
  }
}

test("the Recent fold defaults open and survives a restart", () =>
  withStorage((storage) => {
    assert.equal(loadRecentSessionsCollapsed(), false, "existing users keep an open list");
    saveRecentSessionsCollapsed(true);
    assert.equal(storage.values.get(SIDEBAR_RECENT_COLLAPSED_KEY), "true");
    assert.equal(loadRecentSessionsCollapsed(), true);
    saveRecentSessionsCollapsed(false);
    assert.equal(loadRecentSessionsCollapsed(), false);
    // Anything but an explicit `true` reads as open, so a damaged value never
    // hides the list.
    for (const raw of ["1", '"true"', "{}", "not json"]) {
      storage.values.set(SIDEBAR_RECENT_COLLAPSED_KEY, raw);
      assert.equal(loadRecentSessionsCollapsed(), false, raw);
    }
  }));

test("a folded Recent section keeps its header actions and hands the space to projects", async () => {
  const previousDocument = globalThis.document;
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const preferences = await server.ssrLoadModule("/src/lib/sidebar-preferences.ts");
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const now = Date.now();
    const sessions = ["one", "two", "three"].map((id, index) => ({
      id,
      title: id,
      projectPath: index === 2 ? null : "/work",
      createdAt: new Date(now - index * 1_000).toISOString(),
      updatedAt: new Date(now - index * 1_000).toISOString(),
    }));
    const render = () => {
      Object.assign(useAppStore.getInitialState(), {
        sessions,
        sessionMeta: {},
        projectMeta: {},
        openProjectPaths: ["/work"],
        openProjects: [],
        workspace: null,
        activeProjectPath: null,
        activeSessionId: null,
        selectingSessionId: null,
        page: "chat",
        settings: {},
        projectCollapsed: {},
        sessionView: { sort: "recent", archived: false },
      });
      globalThis.document = { documentElement: { dataset: { theme: "light" } } };
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Sidebar, {
            collapsed: false,
            onToggle() {},
            sidebarWidth: 275,
            onWidthChange() {},
            onWidthCommit() {},
          }),
        ),
      );
    };
    const recent = (html) =>
      html.match(/<section[^>]*data-sidebar-session-section="temporary"[\s\S]*?<\/section>/)?.[0] ?? "";
    const toggle = (html) =>
      recent(html).match(/<button[^>]*data-action="toggle-recent-sessions"[^>]*>/)?.[0] ?? "";
    const list = (html) =>
      recent(html).match(/<div[^>]*id="sidebar-standalone-sessions-list"[^>]*>/)?.[0] ?? "";
    const rows = (html) =>
      [...recent(html).matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);

    await withStorage(async () => {
      const open = render();
      // The label itself is the disclosure button and names the section.
      assert.match(toggle(open), /id="sidebar-standalone-sessions-label"/);
      assert.match(toggle(open), /aria-expanded="true"/);
      assert.match(toggle(open), /aria-controls="sidebar-standalone-sessions-list"/);
      assert.ok(recent(open).includes(`<span>${catalogs.en.nav.recentSessions}</span>`));
      assert.doesNotMatch(list(open), /hidden/);
      assert.deepEqual(rows(open), ["one", "two", "three"]);

      preferences.saveRecentSessionsCollapsed(true);
      const folded = render();
      assert.match(toggle(folded), /aria-expanded="false"/);
      assert.match(toggle(folded), /is-collapsed/);
      assert.match(list(folded), /hidden=""/);
      // Sort and New chat stay in the header while the list is folded.
      assert.match(recent(folded), /data-action="session-sort"/);
      assert.match(recent(folded), /data-action="new-standalone-session"/);
      // Folding Recent leaves the project tree untouched.
      assert.match(folded, /data-sidebar-project-group="\/work"/);
      assert.match(folded, /data-sidebar-session-row="one"/);
    });
  } finally {
    globalThis.document = previousDocument;
    await server.close();
  }
});
