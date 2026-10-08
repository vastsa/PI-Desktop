import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

/*
 * The opener a tool row's summary and a tool result's file/match list call.
 *
 * Those surfaces route a file through `useOpenPreviewTarget`, which is expected
 * to reach the destination of the file it was given rather than one of its own
 * (ADR 0262). The contract is behavioral, so this exercises the real hook with
 * a recorded store and a stubbed `fs.resolveRef` reply: which work-panel entry
 * an actual click produces for each shape of resolution, and what happens when
 * nothing matches.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Compile one desktop module and evaluate it against the given mocks. */
function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const calls = { tabs: [], files: [], urls: [], toasts: [], resolved: [], enabled: [], reloaded: [] };

/** The store the hook reads: mutable state plus recorded actions. */
const state = {
  workspace: { path: "C:/project" },
  activeSessionId: "session-1",
  pluginViews: [],
  openFileInWorkPanel: (...args) => calls.files.push(args),
  openUrlInWorkPanel: (...args) => calls.urls.push(args),
  openWorkPanelTab: (tab) => calls.tabs.push(tab),
  showToast: (...args) => calls.toasts.push(args),
};
const useAppStore = Object.assign((selector) => selector(state), {
  getState: () => state,
  setState: (patch) => Object.assign(state, patch),
});

let pluginSummary = {
  id: "pi.file-manager",
  bundled: true,
  enabled: true,
  status: "ready",
  permissions: ["ui.view"],
  scope: { mode: "global", projects: [] },
};
let listedPluginViews = [];

/** What the next `fs.resolveRef` reply is; each case sets it. */
let nextMatch = null;
let nextReason = null;
let resolveFails = false;
let pluginOperationFails = false;

const workPanelTabs = loadModule("../src/lib/work-panel-tabs.ts", {});
const shared = await import("@pi-desktop/shared");
const { useOpenPreviewTarget } = loadModule("../src/hooks/use-preview-target.ts", {
  react: React,
  "react-i18next": { useTranslation: () => ({ t: (key, values) => `${key}:${values?.name ?? ""}` }) },
  "@pi-desktop/shared": shared,
  "../stores/app-store": { useAppStore },
  "../lib/api": {
    api: {
      fsResolveRef: async (ref) => {
        calls.resolved.push(ref);
        if (resolveFails) throw new Error("host unavailable");
        return { match: nextMatch, ...(nextReason ? { reason: nextReason } : {}) };
      },
      listPlugins: async () => ({ plugins: [pluginSummary] }),
      listPluginViews: async () => listedPluginViews,
      enablePlugin: async (id) => {
        calls.enabled.push(id);
        if (pluginOperationFails) throw new Error("plugin start failed");
        pluginSummary = { ...pluginSummary, enabled: true, status: "ready" };
        listedPluginViews = [{ pluginId: id, viewId: "manager" }];
      },
      reloadPlugin: async (id) => {
        calls.reloaded.push(id);
        if (pluginOperationFails) throw new Error("plugin reload failed");
        pluginSummary = { ...pluginSummary, status: "ready" };
        listedPluginViews = [{ pluginId: id, viewId: "manager" }];
        return {};
      },
    },
  },
  "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {
    "@pi-desktop/shared": await import("@pi-desktop/shared"),
    "./chat-link-scanner.ts": loadModule("../src/lib/chat-link-scanner.ts", {
      "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
    }),
    "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
  }),
  "../lib/open-http-url": { openHttpUrl: (...args) => calls.urls.push(args) },
  "../lib/work-panel-tabs": workPanelTabs,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function reset({ pluginView = false } = {}) {
  Object.values(calls).forEach((list) => list.splice(0, list.length));
  state.pluginViews = pluginView
    ? [{ pluginId: "pi.file-manager", viewId: "manager" }]
    : [];
  nextMatch = null;
  nextReason = null;
  resolveFails = false;
  pluginOperationFails = false;
  pluginSummary = {
    id: "pi.file-manager",
    bundled: true,
    enabled: true,
    status: "ready",
    permissions: ["ui.view"],
    scope: { mode: "global", projects: [] },
  };
  listedPluginViews = pluginView
    ? [{ pluginId: "pi.file-manager", viewId: "manager" }]
    : [];
}

/**
 * Render a component that captures the opener, then click one target with it.
 * The hook is a real hook, so it has to run inside a render; the click happens
 * afterwards so no side effect fires while React is rendering.
 */
async function click(target) {
  let open = null;
  function Harness() {
    open = useOpenPreviewTarget();
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  assert.equal(typeof open, "function", "the hook returned a click handler");
  open(target);
  await flush();
}

async function clickTwice(target) {
  let open = null;
  function Harness() {
    open = useOpenPreviewTarget();
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  assert.equal(typeof open, "function", "the hook returned a click handler");
  open(target);
  open(target);
  await flush();
}

/** The match the main process would report for a project file. */
function projectMatch(overrides = {}) {
  return {
    root: "workspace",
    relativePath: "src/dir/a.ts",
    absolutePath: "C:/project/src/dir/a.ts",
    matchedBy: "exact-relative",
    projectRoot: { primary: true },
    ...overrides,
  };
}

test("a project file a tool surface names opens in the bundled file view", async () => {
  reset({ pluginView: true });
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  // The reference is completed by the main process, not trusted as written.
  assert.deepEqual(calls.resolved, ["src/dir/a.ts"]);
  assert.deepEqual(calls.tabs, [
    {
      id: "plugin:pi.file-manager/manager",
      kind: "plugin",
      resource: "pi.file-manager/manager",
      location: "src/dir/a.ts",
    },
  ]);
  assert.deepEqual(calls.files, [], "the host file tab is not also opened");
  assert.deepEqual(calls.toasts, []);
});

test("a Windows tool path reaches resolution intact and opens its exact project file", async () => {
  reset({ pluginView: true });
  const path = "C:\\demo project\\readme.md";
  nextMatch = projectMatch({ relativePath: "readme.md", absolutePath: path, matchedBy: "exact-absolute" });
  await click({ kind: "file", path });
  assert.deepEqual(calls.resolved, [path]);
  assert.equal(calls.tabs[0].location, "readme.md");
  assert.deepEqual(calls.toasts, []);
});

test("a project file still falls back when the bundled manager is absent", async () => {
  reset();
  pluginSummary = { ...pluginSummary, bundled: false };
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.tabs, []);
  assert.equal(calls.files.length, 1);
  assert.equal(calls.files[0][0], "src/dir/a.ts");
  assert.equal(calls.toasts[0][0], "chat.fileManagerUnavailable:");
});

test("a project file click enables the bundled file manager before opening it", async () => {
  reset();
  pluginSummary = { ...pluginSummary, enabled: false, status: "disabled" };
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.enabled, ["pi.file-manager"]);
  assert.deepEqual(calls.tabs, [
    {
      id: "plugin:pi.file-manager/manager",
      kind: "plugin",
      resource: "pi.file-manager/manager",
      location: "src/dir/a.ts",
    },
  ]);
  assert.deepEqual(calls.files, []);
});

test("a project file click retries a bundled view missing during startup", async () => {
  reset();
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.reloaded, ["pi.file-manager"]);
  assert.equal(calls.tabs[0].resource, "pi.file-manager/manager");
  assert.deepEqual(calls.files, []);
});

test("simultaneous file clicks share one bundled view startup", async () => {
  reset();
  nextMatch = projectMatch();
  await clickTwice({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.reloaded, ["pi.file-manager"]);
  assert.equal(calls.tabs.length, 2);
});

test("a project-scoped file manager is not enabled outside its selected projects", async () => {
  reset();
  pluginSummary = {
    ...pluginSummary,
    enabled: false,
    status: "disabled",
    scope: { mode: "projects", projects: ["C:/another-project"] },
  };
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.enabled, []);
  assert.equal(calls.files[0][0], "src/dir/a.ts");
  assert.equal(calls.toasts[0][0], "chat.fileManagerUnavailable:");
});

test("a missing ui.view grant is not restored by a file click", async () => {
  reset();
  pluginSummary = { ...pluginSummary, enabled: false, status: "disabled", permissions: [] };
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.enabled, []);
  assert.deepEqual(calls.reloaded, []);
  assert.equal(calls.files[0][0], "src/dir/a.ts");
  assert.equal(calls.toasts[0][0], "chat.fileManagerUnavailable:");
});

test("a failed file-manager start reports the fallback and opens the host viewer", async () => {
  reset();
  pluginSummary = { ...pluginSummary, enabled: false, status: "disabled" };
  pluginOperationFails = true;
  nextMatch = projectMatch();
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.enabled, ["pi.file-manager"]);
  assert.equal(calls.toasts[0][0], "chat.fileManagerUnavailable:");
  assert.equal(calls.files[0][0], "src/dir/a.ts");
});

test("a scratch or attachment file a tool surface names opens on the host file tab", async () => {
  reset({ pluginView: true });
  nextMatch = {
    root: "scratch",
    relativePath: "notes.md",
    absolutePath: "C:/data/scratch/session-1/notes.md",
    matchedBy: "exact-relative",
  };
  await click({ kind: "file", path: "notes.md" });
  assert.deepEqual(calls.tabs, [], "a file outside the project root is not the view's to show");
  assert.equal(calls.files[0][0], "C:/data/scratch/session-1/notes.md");
});

test("a file from a sibling project folder opens in the view by absolute path", async () => {
  reset({ pluginView: true });
  nextMatch = projectMatch({
    relativePath: "lib/only-here.ts",
    absolutePath: "C:/project-second/lib/only-here.ts",
    projectRoot: { primary: false },
  });
  await click({ kind: "file", path: "lib/only-here.ts" });
  assert.equal(calls.tabs[0].location, "C:/project-second/lib/only-here.ts");
});

test("a primary-folder HTML page stays with the side browser", async () => {
  reset({ pluginView: true });
  nextMatch = projectMatch({ relativePath: "docs/page.html", absolutePath: "C:/project/docs/page.html" });
  await click({ kind: "file", path: "docs/page.html" });
  assert.deepEqual(calls.tabs, [], "a page to run is not a file to read");
  assert.deepEqual(calls.urls, [["docs/page.html"]]);
});

test("a reference nothing answers reports itself and opens nothing", async () => {
  reset({ pluginView: true });
  nextMatch = null;
  await click({ kind: "file", path: "missing-helper.js" });
  assert.deepEqual(calls.tabs, []);
  assert.deepEqual(calls.files, []);
  assert.deepEqual(calls.urls, []);
  assert.equal(calls.toasts[0][0], "chat.fileRefMissing:missing-helper.js");
});

test("an absolute tool path outside allowed roots reports the access limit", async () => {
  reset({ pluginView: true });
  nextReason = "outside-allowed-roots";
  await click({ kind: "file", path: "C:\\elsewhere\\readme.md" });
  assert.deepEqual(calls.resolved, ["C:\\elsewhere\\readme.md"]);
  assert.deepEqual(calls.tabs, []);
  assert.equal(calls.toasts[0][0], "chat.fileRefRestricted:C:\\elsewhere\\readme.md");
});

test("a failing resolve is reported instead of opening a panel", async () => {
  reset({ pluginView: true });
  resolveFails = true;
  await click({ kind: "file", path: "src/dir/a.ts" });
  assert.deepEqual(calls.tabs, []);
  assert.deepEqual(calls.files, []);
  assert.equal(calls.toasts[0][0], "chat.fileRefLookupFailed:");
});

test("a URL target keeps the embedded browser and never reaches file resolution", async () => {
  reset({ pluginView: true });
  await click({ kind: "url", url: "https://example.com/docs" });
  assert.deepEqual(calls.resolved, []);
  assert.deepEqual(calls.urls, [["https://example.com/docs"]]);
  assert.deepEqual(calls.tabs, []);
});
