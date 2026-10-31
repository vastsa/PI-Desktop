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

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

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
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

    const render = (state) => {
      Object.assign(useAppStore.getInitialState(), {
        workspace: { path: "/workspace", name: "Workspace" },
        projectMeta: {},
        ...state,
      });
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
    };

    return await work({ render });
  } finally {
    await server.close();
  }
}

test("an editable session renders the title as a real rename trigger", async () => {
  await withTopbar(async ({ render }) => {
    const html = render({
      activeSessionId: "session-local",
      sessions: [{ id: "session-local", title: "Draft reference check", projectPath: "/project" }],
      projectMeta: { "/project": { name: "Project" } },
    });

    assert.match(
      html,
      /<h1 class="ct-title"><button type="button" class="ct-title-trigger" aria-label="Rename task Draft reference check">Draft reference check<\/button><\/h1>/,
    );
    assert.ok(!html.includes("ct-title-input"), "the editor only appears after a click");
    assert.ok(html.includes('title="Project · Draft reference check"'));
  });
});

test("remote, scheduled and empty sessions render a plain title", async () => {
  await withTopbar(async ({ render }) => {
    const remote = render({
      activeSessionId: "remote:7",
      sessions: [
        {
          id: "remote:7",
          source: "remote",
          title: "Remote build",
          remoteWorkspaceLabel: "Remote workspace",
          remoteHostLabel: "builder",
        },
      ],
    });
    assert.match(remote, /<h1 class="ct-title">Remote build<\/h1>/);
    assert.ok(!remote.includes("ct-title-trigger"));

    const scheduled = render({
      activeSessionId: "session-scheduled",
      sessions: [{ id: "session-scheduled", title: "Nightly check", scheduledRun: true }],
    });
    assert.match(scheduled, /<h1 class="ct-title">Nightly check<\/h1>/);
    assert.ok(!scheduled.includes("ct-title-trigger"));

    const empty = render({ activeSessionId: null, sessions: [] });
    assert.match(empty, /<h1 class="ct-title">New task<\/h1>/);
    assert.ok(!empty.includes("ct-title-trigger"));
  });
});

test("inline rename wires the edit lifecycle through the store", async () => {
  const source = await read("../src/components/ConversationTopbar.tsx");

  // Entry: a labelled button replaces the h1 with a focused, selected editor.
  assert.match(source, /aria-label=\{t\("session\.renameAction", \{ title: fullTaskTitle \}\)\}/);
  assert.match(source, /aria-label=\{t\("session\.renameLabel"\)\}/);
  assert.match(
    source,
    /const frame = requestAnimationFrame\(\(\) => \{[\s\S]*?inputRef\.current\?\.focus\(\);[\s\S]*?inputRef\.current\?\.select\(\);[\s\S]*?\}\);/,
  );

  // Enter commits, Escape cancels, and blur is the third commit path.
  assert.match(source, /onKeyDown=\{onRenameKeyDown\}/);
  assert.match(source, /onBlur=\{commitRename\}/);
  assert.match(source, /if \(event\.nativeEvent\.isComposing\) return;/);
  assert.match(source, /if \(event\.key === "Enter"\) \{[\s\S]*?commitRename\(\);/);
  assert.match(source, /if \(event\.key === "Escape"\) \{[\s\S]*?cancelRename\(\);/);

  // Trimmed and unchanged drafts are silent no-ops; a changed one is persisted.
  assert.match(source, /const nextTitle = draft\.trim\(\);/);
  assert.match(source, /if \(!nextTitle \|\| nextTitle === previousTitle\) return;/);
  assert.match(source, /renameSession\(sessionId, nextTitle\)/);
  assert.match(
    source,
    /showToast\(error instanceof Error \? error\.message : String\(error\), \{[\s\S]*?variant: "error",[\s\S]*?\}\);/,
  );

  // The editor only exists for an editable session and cannot outlive it.
  assert.match(source, /activeSession && !isRemoteSession\(activeSession\) && !activeSession\.scheduledRun/);
  assert.match(source, /canRename \? \([\s\S]*?className="ct-title-trigger"/);
  assert.match(source, /useEffect\(\(\) => \{\s*setEditingId\(null\);\s*\}, \[activeSessionId\]\)/);
  assert.match(source, /title=\{editing \? undefined : breadcrumbTitle\}/);

  // Double commits are blocked once Enter/Escape/blur has settled the draft.
  assert.match(source, /const renameSettledRef = useRef\(false\)/);
  assert.match(source, /if \(!editing \|\| !activeSession \|\| renameSettledRef\.current\) return;/);
  assert.match(source, /renameSettledRef\.current = true;/);

  // The editor takes code-point slices of the shared limit.
  assert.match(source, /MAX_SESSION_TITLE_LENGTH/);
  assert.match(
    source,
    /Array\.from\(event\.target\.value\)[\s\S]*?\.slice\(0, MAX_SESSION_TITLE_LENGTH\)[\s\S]*?\.join\(""\)/,
  );
});

test("the title editor is visually unstyled but clickable", async () => {
  const styles = await loadStyles();
  const block = (selector) => {
    const match = styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\}`));
    assert.ok(match, `${selector} rules not found`);
    return match[1];
  };

  const trigger = block("\\.conversation-topbar \\.ct-title-trigger");
  assert.match(trigger, /font: inherit;/);
  assert.match(trigger, /color: inherit;/);
  assert.match(trigger, /text-overflow: ellipsis;/);
  assert.match(trigger, /cursor: text;/);
  assert.match(trigger, /-webkit-app-region: no-drag;/);
  assert.match(trigger, /app-region: no-drag;/);
  assert.doesNotMatch(trigger, /font-size:/, "the trigger keeps the title's type metrics");

  // The lane clips a ring, so keyboard focus is an accent underline instead.
  const focus = block("\\.conversation-topbar \\.ct-title-trigger:focus-visible");
  assert.match(focus, /outline: none;/);
  assert.match(focus, /text-decoration: underline;/);
  assert.match(focus, /text-decoration-color: var\(--ds-accent\);/);

  const input = block("\\.conversation-topbar \\.ct-title-input");
  assert.match(input, /border: 0;/);
  assert.match(input, /padding: 0;/);
  assert.match(input, /background: transparent;/);
  assert.match(input, /box-shadow: none;/);
  assert.match(input, /font-size: var\(--text-sm-plus\);/);
  assert.match(input, /font-weight: var\(--font-weight-medium\);/);
  assert.match(input, /line-height: var\(--leading-compact\);/);
  assert.match(input, /-webkit-app-region: no-drag;/);
  assert.match(input, /app-region: no-drag;/);

  const wrap = block("\\.conversation-topbar \\.ct-title-wrap");
  assert.match(wrap, /-webkit-app-region: drag;/, "the empty title lane stays draggable");
});
