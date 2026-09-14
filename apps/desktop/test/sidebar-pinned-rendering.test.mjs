import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

test("sidebar renders global pins once, outside project folding and history limits", async () => {
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
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const old = "2020-01-01T00:00:00Z";
    const session = (id, projectPath, updatedAt = old) => ({
      id,
      title: id,
      projectPath,
      createdAt: old,
      updatedAt,
    });
    const pins = [
      session("open-pin", "/open"),
      session("collapsed-pin", "/collapsed"),
      session("closed-pin", "/closed"),
      session("temporary-pin", null),
      session("archived-pin", "/open"),
      session("archived-project-pin", "/archived"),
    ];
    const normal = Array.from({ length: 11 }, (_, index) =>
      session(`normal-${String(index).padStart(2, "0")}`, "/open", new Date().toISOString()),
    );
    const meta = Object.fromEntries(pins.map(({ id }) => [id, { pinned: true }]));
    meta["archived-pin"].archived = true;
    const seed = {
      sessions: [...pins, ...normal, session("temporary-normal", null)],
      sessionMeta: meta,
      projectMeta: {
        "/closed": { name: "Closed project" },
        "/collapsed": { collapsed: true },
        "/archived": { archived: true },
      },
      openProjectPaths: ["/open", "/collapsed"],
      openProjects: [],
      workspace: null,
      activeProjectPath: null,
      projectCollapsed: {},
      sessionView: { sort: "recent", archived: false },
    };
    const render = (overrides = {}) => {
      Object.assign(useAppStore.getInitialState(), seed, overrides);
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
    const rows = (html) =>
      [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);
    const pinnedSection = (html) =>
      html.match(/<section[^>]*data-sidebar-session-section="pinned"[\s\S]*?<\/section>/)?.[0] ??
      "";
    const html = render();
    const expectedPins = ["closed-pin", "collapsed-pin", "open-pin", "temporary-pin"];
    assert.deepEqual(rows(pinnedSection(html)), expectedPins);
    assert.match(pinnedSection(html), />Closed project<\/span>/);
    assert.ok(pinnedSection(html).includes(catalogs.en.nav.hoverCardTemporarySpace));
    assert.doesNotMatch(pinnedSection(html), /sidebar-time-group/);
    assert.ok(
      html.indexOf('data-sidebar-session-section="pinned"') <
        html.indexOf('data-sidebar-session-section="temporary"'),
    );
    assert.equal(rows(html).length, new Set(rows(html)).size, "pins have no duplicate rows");
    assert.equal(rows(html).filter((id) => id.startsWith("normal-")).length, 10);
    assert.ok(rows(html).includes("temporary-normal"));
    assert.ok(!rows(html).includes("archived-pin"));
    assert.ok(!rows(html).includes("archived-project-pin"));

    const unpinned = render({ sessionMeta: {} });
    assert.equal(pinnedSection(unpinned), "");
    assert.ok(rows(unpinned).includes("temporary-pin"));
    assert.ok(!rows(unpinned).includes("closed-pin"), "unpin respects closed project tabs");
    const collapsedGroup =
      unpinned.match(/data-sidebar-project-group="\/collapsed"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      collapsedGroup,
      /class="sidebar-session-group-body project collapsed"[^>]*aria-hidden="true"/,
    );
    assert.deepEqual(rows(collapsedGroup), ["collapsed-pin"], "unpin returns to folded history");
    const restored = render({ sessionView: { sort: "recent", archived: true } });
    assert.equal(rows(pinnedSection(restored)).length, pins.length);
    assert.equal(rows(restored).length, new Set(rows(restored)).size);
  } finally {
    globalThis.document = previousDocument;
    await server.close();
  }
});
