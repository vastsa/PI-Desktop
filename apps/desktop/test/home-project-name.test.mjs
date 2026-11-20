import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

/**
 * The empty home names the project the user is working in. Opening a project
 * creates no session, so the hero has to fall back to the active workspace
 * instead of showing the generic title; a session on screen still wins, which
 * is what keeps a temporary session temporary.
 *
 * ChatSurface renders the real composer, which reads browser globals at render
 * time, so this process provides the few it needs. Server rendering runs no
 * effects: the assertion reads the first frame of the mount.
 */
globalThis.window ??= {
  piDesktop: undefined,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage ??= globalThis.window.localStorage;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

const emptyStateOf = (html) => ({
  kind: html.match(/data-home-session-kind="([^"]*)"/)?.[1],
  title: html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "",
});

test("the empty home names the project even before its first session exists", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const { ChatSurface } = await server.ssrLoadModule(
    "/src/components/ChatSurface.tsx",
  );
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

  const render = (state) => {
    Object.assign(useAppStore.getInitialState(), {
      activeSessionId: undefined,
      selectingSessionId: undefined,
      retainedSessionIds: [],
      sessions: [],
      messages: [],
      workspace: null,
      activeProjectPath: undefined,
      error: null,
      ...state,
    });
    return emptyStateOf(
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(ChatSurface, {})),
      ),
    );
  };

  // A freshly opened project owns the empty home: the title names it and the
  // switcher offers the same project path.
  const opened = render({
    workspace: { path: "/work/demo-app", name: "Demo App" },
    activeProjectPath: "/work/demo-app",
  });
  assert.equal(opened.kind, "project");
  assert.match(opened.title, /^What can we build in /);
  assert.match(opened.title, /switch project: Demo App/i);
  assert.match(opened.title, /title="\/work\/demo-app"/);
  assert.doesNotMatch(opened.title, /What can I help you build\?/);

  // Without a project name the hero still names the folder it opened.
  const unnamed = render({ workspace: { path: "/work/demo-app" } });
  assert.equal(unnamed.kind, "project");
  assert.match(unnamed.title, /class="project-underline-name">demo-app<\/span>/);

  // A session on screen decides: a temporary session stays temporary even when
  // a workspace is still open.
  const temporary = render({
    activeSessionId: "s1",
    sessions: [{ id: "s1", title: "New task", projectPath: null }],
    workspace: { path: "/work/demo-app", name: "Demo App" },
    activeProjectPath: "/work/demo-app",
  });
  assert.equal(temporary.kind, "temporary");
  assert.equal(
    temporary.title,
    catalogs.en.chat.emptyTitleTemporary,
    "a temporary session must not inherit the open project's name",
  );

  // With no project and no session the generic home title is still correct.
  const bare = render({});
  assert.equal(bare.kind, "empty");
  assert.equal(bare.title, catalogs.en.chat.emptyTitle);
});
