import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * The topbar reads the store through `getInitialState` on the server, so the
 * harness mutates that snapshot instead of calling actions (no IPC in tests).
 */
async function withTopbar(work) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ConversationTopbar } = await server.ssrLoadModule(
      "/src/components/ConversationTopbar.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const { remoteEn } = await server.ssrLoadModule("/src/locales/remote.ts");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en, remote: remoteEn } },
    });

    const render = (state, sidebarCollapsed = false) => {
      Object.assign(useAppStore.getInitialState(), {
        /* A different global workspace proves the crumb follows the session. */
        workspace: { path: "/workspace", name: "Workspace" },
        projectMeta: {},
        ...state,
      });
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ConversationTopbar, {
            sidebarCollapsed,
            workPanelOpen: false,
            onToggleSidebar() {},
            onNewTask() {},
            onOpenSearch() {},
          }),
        ),
      );
    };

    return await work({ render });
  } finally {
    await server.close();
  }
}

test("topbar renders the session's project crumb and preserves complete titles", async () => {
  await withTopbar(async ({ render }) => {
    for (const title of ["Draft reference check", "修复会话标题在窗口顶部的显示", "New task"]) {
      for (const sidebarCollapsed of [false, true]) {
        const html = render(
          {
            activeSessionId: "title-test",
            sessions: [{ id: "title-test", title, projectPath: "/project" }],
            projectMeta: { "/project": { name: "Project" } },
          },
          sidebarCollapsed,
        );
        const expected =
          title === "New task" ? catalogs.en.chat.untitledTask : title;
        const trigger = html.match(
          /<h1 class="ct-title"><button type="button" class="ct-title-trigger" aria-label="([^"]*)">([^<]*)<\/button><\/h1>/,
        );

        assert.ok(trigger, "the title keeps a real, labelled rename trigger");
        assert.equal(trigger[2], expected, "the full title is never shortened for width");
        assert.equal(
          trigger[1],
          `Rename task ${expected}`,
          "the rename affordance carries the visible title",
        );
        assert.ok(
          html.includes('class="ct-project"') &&
            html.includes('class="ct-project-name">Project</span>'),
          "the crumb names the session's project",
        );
        assert.ok(
          html.includes('<span class="ct-sep" aria-hidden="true">/</span>'),
          "the project and the task are separated by a slash",
        );
        assert.ok(html.includes(`title="Project · ${expected}"`));
        assert.ok(
          !html.includes("Workspace"),
          "the crumb never falls back to the global workspace",
        );
        assert.ok(!html.includes("ct-title-input"), "the editor is closed at rest");
      }
    }
  });
});

test("a session without a project keeps only the title", async () => {
  await withTopbar(async ({ render }) => {
    const html = render({
      activeSessionId: "temp-test",
      sessions: [{ id: "temp-test", title: "Scratch pad" }],
      projectMeta: { "/project": { name: "Project" } },
    });

    assert.ok(!html.includes('class="ct-project"'), "no folder crumb without a project");
    assert.ok(!html.includes('class="ct-sep"'), "no separator without a project");
    assert.match(html, /class="ct-title">[\s\S]*?Scratch pad/);
    assert.ok(html.includes('title="Scratch pad"'));
  });
});

test("an empty chat names the active workspace and stays read-only", async () => {
  await withTopbar(async ({ render }) => {
    const html = render({
      activeSessionId: null,
      sessions: [],
      workspace: { path: "/workspace", name: "Workspace" },
    });

    assert.ok(html.includes('class="ct-project-name">Workspace</span>'));
    assert.match(html, /<h1 class="ct-title">New task<\/h1>/);
    assert.ok(html.includes('title="Workspace · New task"'));
    assert.ok(!html.includes("ct-title-trigger"), "there is no session to rename yet");
  });
});

test("a remote session shows its remote workspace label and keeps the title read-only", async () => {
  await withTopbar(async ({ render }) => {
    const html = render({
      activeSessionId: "remote:42",
      sessions: [
        {
          id: "remote:42",
          source: "remote",
          title: "Remote build",
          /* A remote summary's path is display data, never a local project. */
          projectPath: "/local-ignored",
          remoteWorkspaceLabel: "Remote workspace",
          remoteHostLabel: "builder",
        },
      ],
      projectMeta: { "/local-ignored": { name: "Local project" } },
    });

    assert.ok(
      html.includes('class="ct-project-name">Remote workspace</span>'),
      "the remote label replaces the local project name",
    );
    assert.ok(!html.includes("Local project"));
    assert.ok(!html.includes("ct-title-trigger"), "host-owned titles are not editable here");
    assert.match(html, /<h1 class="ct-title">Remote build<\/h1>/);
    assert.ok(html.includes("Remote · builder"));
    assert.ok(html.includes('title="Remote workspace · Remote build"'));
  });
});

test("a scheduled run keeps its plain title and its way back", async () => {
  await withTopbar(async ({ render }) => {
    const html = render({
      activeSessionId: "session-scheduled",
      sessions: [
        {
          id: "session-scheduled",
          title: "Nightly dependency check",
          scheduledRun: true,
          projectPath: "/project",
        },
      ],
      projectMeta: { "/project": { name: "Project" } },
    });

    assert.ok(html.includes('class="ct-project-name">Project</span>'));
    assert.ok(!html.includes("ct-title-trigger"), "automation transcripts stay read-only");
    assert.match(html, /<h1 class="ct-title">Nightly dependency check<\/h1>/);
    assert.match(html, /class="ct-back"/);
  });
});

test("the crumb keeps the top bar's quiet type scale and six-pixel rhythm", async () => {
  const styles = await loadStyles();
  const source = await readFile(
    new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    styles,
    /\.conversation-topbar \.ct-title-wrap \{[\s\S]*?gap: 6px;/,
  );
  assert.match(
    styles,
    /\.conversation-topbar \.ct-project \{[\s\S]*?gap: 6px;[\s\S]*?color: var\(--ds-text-faint\);[\s\S]*?font-size: var\(--text-xs\);/,
  );
  assert.match(
    styles,
    /\.conversation-topbar \.ct-sep \{[\s\S]*?color: var\(--ds-border-strong\);/,
  );
  assert.match(source, /<IconFolder size=\{12\} aria-hidden \/>/);
});
