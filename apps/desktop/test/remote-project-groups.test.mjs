import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/*
 * A host project group must sit in the sidebar like a local one, and the
 * sidebar must label the set it belongs to.
 *
 * The group is keyed by `[hostKey, projectId]` rather than a filesystem path,
 * so the section heading, the shared project sort, and the per-row source chip
 * are all reached through a different code path here than for a local project.
 * Without the heading a host group reads as a retained local one, and without
 * the shared sort its position follows whichever host session arrived first.
 *
 * The group body is rendered through the real component, store, and locale, so
 * the assertions are the markup the sidebar actually produces.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The section heading, its styling, and the row-level chip live outside the
// component, so they are checked against the sidebar source itself.
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const sidebarStyles = await readFile(
  new URL("../src/styles/sessions.css", import.meta.url),
  "utf8",
);

const project = {
  key: JSON.stringify(["ssh-fixture", "p7"]),
  hostKey: "ssh-fixture",
  projectId: "p7",
  label: "713Air",
  hostLabel: "mac-mini",
  connected: true,
};

const session = (id, title) => ({
  id: `remote:ssh-fixture:${id}`,
  source: "remote",
  remoteHostKey: project.hostKey,
  remoteHostLabel: project.hostLabel,
  remoteProjectId: project.projectId,
  remoteWorkspaceLabel: project.label,
  title,
  messageCount: 0,
  mode: "agent",
  permissionMode: "ask",
  thinkingLevel: "inherit",
  capabilities: {
    canPrompt: true,
    canStop: true,
    canRefresh: true,
    canReadWorkspace: true,
    canConfigureModel: false,
    canAttach: false,
    canSteer: false,
    canEditMessages: false,
    canUseLocalTools: false,
    canUseTerminal: false,
  },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

async function withGroups(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { RemoteProjectGroups } = await server.ssrLoadModule(
      "/src/components/remote/RemoteProjectGroups.tsx",
    );
    const { remoteProjectCollapseKey } = await server.ssrLoadModule(
      "/src/lib/remote-project-catalog.ts",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    const render = (sessions, collapsed) => {
      const collapseKey = remoteProjectCollapseKey(project.key);
      Object.assign(useAppStore.getInitialState(), {
        projectCollapsed: collapsed ? { [collapseKey]: true } : {},
      });
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(RemoteProjectGroups, {
            groups: [{ project, sessions }],
            renderSessions: (rows) =>
              rows.map((row) =>
                createElement(
                  "div",
                  { className: "thread-item", key: row.id },
                  row.title,
                ),
              ),
          }),
        ),
      );
    };
    await run({ render, useAppStore, remoteProjectCollapseKey });
  } finally {
    await server.close();
  }
}

test("a host project group folds through the same disclosure a local group uses", async () => {
  await withGroups(({ render }) => {
    const html = render([session("s1", "Remote work")], false);
    assert.match(html, /data-action="toggle-project-collapse"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /aria-controls="[^"]*p7[^"]*-sessions"/);
    // Rows live in the animatable body, not as loose siblings of the header.
    assert.match(html, /class="sidebar-session-group-body project\s*"/);
    assert.match(html, /class="sidebar-session-group-clip"/);
    assert.match(html, /class="sidebar-session-group-list"/);
    assert.match(html, /Remote work/);
    assert.doesNotMatch(html, /is-collapsed/);
  });
});

test("collapsing a host project group folds its rows without dropping them", async () => {
  await withGroups(({ render }) => {
    const html = render([session("s1", "Remote work")], true);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /is-collapsed/);
    assert.match(html, /sidebar-session-group-body project collapsed/);
    // Hidden from assistive tech and from pointer/keyboard while folded, so the
    // closed group is not a focus trap.
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /inert=""/);
    // The row is still in the DOM; only the collapsed row hides it, so
    // expanding restores the list without a refetch.
    assert.match(html, /Remote work/);
  });
});

test("the new-task action stays on the header and never becomes the fold toggle", async () => {
  await withGroups(({ render }) => {
    const collapsed = render([session("s1", "Remote work")], true);
    // The `+` action must survive a folded group: it is how a user creates the
    // first conversation in a project they just closed.
    assert.match(collapsed, /aria-label="New task: 713Air · mac-mini"/);
  });
});

test("the fold uses shared project state under a host-namespaced key", async () => {
  await withGroups(({ render, useAppStore, remoteProjectCollapseKey }) => {
    render([session("s1", "Remote work")], false);
    const collapseKey = remoteProjectCollapseKey(project.key);
    useAppStore.getState().setProjectCollapsed(collapseKey, true);
    const state = useAppStore.getState();
    assert.equal(
      state.projectCollapsed[collapseKey],
      true,
      "the fold is remembered per group",
    );
    assert.ok(collapseKey.startsWith("remote::"));
    // `openProjectPaths` is the retained local project list; a host catalog key
    // landing there would resurrect a group after the project is gone.
    assert.deepEqual(state.openProjectPaths, []);
  });
});

test("host groups sit under their own section heading beside Projects", () => {
  const heading = sidebarSource.match(
    /<div className="sidebar-list-subheader" data-sidebar-section="remote">[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(heading, "the sidebar emits a remote section heading");
  assert.match(heading, /t\("nav\.remoteProjects"/);
  // The heading owns the groups: it is emitted before them inside the same
  // list, so host groups read as a sibling section instead of trailing the
  // local project groups unlabelled.
  const headingAt = sidebarSource.indexOf('data-sidebar-section="remote"');
  const groupsAt = sidebarSource.indexOf("<RemoteProjectGroups");
  assert.ok(groupsAt > headingAt, "the heading precedes the host groups");
  // The heading is only emitted when a host actually has groups.
  assert.match(
    sidebarSource,
    /\{remoteProjectGroups\.length > 0 \? \([\s\S]*?data-sidebar-section="remote"[\s\S]*?<RemoteProjectGroups/,
  );

  const rule = sidebarStyles.match(/\.sidebar-list-subheader \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(rule, "the heading has its own box, not the toolbar's");
  assert.match(rule, /display: flex;/);
  // Matches the Projects toolbar's side inset once the list's own padding is
  // added, so the two headings share one left rail.
  assert.match(rule, /padding: 8px 2px 0;/);

  // The heading already names the host class, so rows under it do not repeat a
  // "Remote" chip on every conversation.
  assert.match(sidebarSource, /insideRemoteSection: true/);
  assert.match(
    sidebarSource,
    /isRemoteSession\(session\) && !options\?\.insideRemoteSection/,
  );
});

test("every locale names the remote section", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const label = catalog.nav?.remoteProjects;
    assert.equal(
      typeof label,
      "string",
      `${locale} is missing nav.remoteProjects`,
    );
    assert.ok(label.trim().length > 0, `${locale} has an empty nav.remoteProjects`);
  }
});