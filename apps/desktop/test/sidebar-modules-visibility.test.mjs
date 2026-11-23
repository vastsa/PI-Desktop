import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

const session = (id, projectPath) => ({
  id,
  title: id,
  projectPath,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
});

test("settings sidebar modules hide and restore each sidebar module", async () => {
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
    const { SidebarModulesSettings } = await server.ssrLoadModule(
      "/src/components/settings/SidebarModulesSettings.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

    const seed = {
      sessions: [
        session("pinned-in-project", "/open"),
        session("project-row", "/open"),
        session("loose-row", null),
      ],
      sessionMeta: { "pinned-in-project": { pinned: true } },
      projectMeta: {},
      openProjectPaths: ["/open"],
      openProjects: [],
      workspace: null,
      activeProjectPath: null,
      activeSessionId: null,
      selectingSessionId: null,
      page: "chat",
      projectCollapsed: {},
      sessionView: { sort: "recent", archived: false },
    };
    const renderSidebar = (settings) => {
      Object.assign(useAppStore.getInitialState(), seed, { settings });
      globalThis.document = { documentElement: { dataset: { theme: "light" } } };
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Sidebar, {
            onToggleSidebar() {},
            onNewTask() {},
            sidebarToggleShortcut: "",
            sidebarWidth: 275,
            onWidthChange() {},
            onWidthCommit() {},
            onResizeCollapse() {},
          }),
        ),
      );
    };
    const renderSettings = (settings) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SidebarModulesSettings, {
            settings,
            saveSettings: async () => {},
          }),
        ),
      );
    const markers = {
      newTask: 'data-nav="new-task"',
      scheduled: 'data-nav="scheduled"',
      pluginMarket: 'data-nav="plugins"',
      pinnedSessions: 'data-sidebar-session-section="pinned"',
      sessions: 'data-sidebar-session-section="temporary"',
      sessionSort: 'data-action="session-sort"',
      newSession: 'data-action="new-standalone-session"',
      projects: 'data-sidebar-section="projects"',
      newProject: 'data-action="new-project"',
      projectNewTask: 'class="sidebar-session-group-add"',
      buildVersion: 'data-nav="build"',
    };
    const children = {
      sessions: ["sessionSort", "newSession"],
      projects: ["newProject", "projectNewTask"],
    };
    const rows = (html) =>
      [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);
    const toggle = (html, label) =>
      html.match(new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
    const label = (id) => catalogs.en.settings.sidebarModule[id];

    // Default: every module renders and every switch is on.
    const defaults = renderSidebar({});
    for (const [id, marker] of Object.entries(markers)) {
      assert.ok(defaults.includes(marker), `${id} visible by default`);
    }
    assert.ok(defaults.includes('data-nav="settings"'));
    const defaultCard = renderSettings({});
    assert.ok(defaultCard.includes(catalogs.en.settings.sidebarModules));
    for (const id of Object.keys(markers)) {
      assert.match(toggle(defaultCard, label(id)), /aria-checked="true"/, `${id} switch on`);
    }

    // Each module can be switched off on its own; Settings always stays.
    for (const [id, marker] of Object.entries(markers)) {
      const html = renderSidebar({ sidebarModules: { [id]: false } });
      assert.ok(!html.includes(marker), `${id} hidden`);
      assert.ok(html.includes('data-nav="settings"'), `settings kept with ${id} hidden`);
      for (const [other, otherMarker] of Object.entries(markers)) {
        if (other === id || children[id]?.includes(other)) continue;
        assert.ok(html.includes(otherMarker), `${other} unaffected by ${id}`);
      }
    }

    // A hidden pinned section returns pins to their own list instead of losing them.
    const unpinnedView = renderSidebar({ sidebarModules: { pinnedSessions: false } });
    const projectGroup =
      unpinnedView.match(/data-sidebar-project-group="\/open"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.deepEqual(rows(projectGroup), ["pinned-in-project", "project-row"]);

    // A hidden section takes its buttons with it; the switches stay stored but disabled.
    const noSessions = { sidebarModules: { sessions: false, sessionSort: true } };
    const noSessionsHtml = renderSidebar(noSessions);
    assert.ok(!noSessionsHtml.includes(markers.sessionSort));
    assert.ok(!rows(noSessionsHtml).includes("loose-row"));
    const noSessionsCard = renderSettings(noSessions);
    assert.match(toggle(noSessionsCard, label("sessions")), /aria-checked="false"/);
    assert.match(toggle(noSessionsCard, label("sessionSort")), /aria-checked="true"[^>]*disabled=""/);
    assert.doesNotMatch(toggle(noSessionsCard, label("projects")), /disabled/);

    // Without projects the session list takes the freed height.
    const noProjects = renderSidebar({ sidebarModules: { projects: false } });
    assert.match(noProjects, /class="sidebar-standalone-sessions is-fill"/);
    assert.ok(!noProjects.includes('data-sidebar-project-group="/open"'));
    // Recent still lists project sessions, so they stay reachable.
    assert.deepEqual(rows(noProjects).filter((id) => id === "project-row"), ["project-row"]);

    // Scheduled stays off while scheduled tasks are disabled, and its switch says so.
    const scheduledOff = { scheduledTasksEnabled: false };
    assert.ok(!renderSidebar(scheduledOff).includes(markers.scheduled));
    assert.match(toggle(renderSettings(scheduledOff), label("scheduled")), /disabled=""/);
  } finally {
    await server.close();
    globalThis.document = previousDocument;
  }
});
