/**
 * A file the conversation already recognised is a file the user can act on.
 *
 * HTML references have explicit open destinations in their context menu. Each
 * destination goes through the same completion as a click, so a shorthand that
 * resolves to nothing cannot open a different file (ADR 0262/0263).
 *
 * The destination half is asserted behaviorally: the real hooks run against a
 * recorded store and stubbed host replies, because the contract is the resolved
 * address handed to each destination, not the shape of the menu.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { readTranscriptSource } from "./helpers/source-contracts.mjs";

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

const calls = {
  tabs: [],
  files: [],
  urls: [],
  defaultBrowsers: [],
  toasts: [],
  resolved: [],
  menus: [],
  reveals: [],
};

let revealFails = false;

const state = {
  sessions: [],
  workspace: { path: "C:/project" },
  activeSessionId: "session-1",
  pluginViews: [
    { pluginId: "pi.file-manager", viewId: "manager" },
    { pluginId: "pi.browser", viewId: "browser" },
  ],
  openFileInWorkPanel: (...args) => calls.files.push(args),
  openUrlInWorkPanel: (...args) => calls.urls.push(args),
  openWorkPanelTab: (tab) => calls.tabs.push(tab),
  showToast: (...args) => calls.toasts.push(args),
};
const useAppStore = Object.assign(
  (selector) => selector(state),
  {
    getState: () => state,
    setState: (update) => Object.assign(state, update),
  },
);

let nextMatch = null;
let clipboardFails = false;
const copied = [];

/*
  The hooks read `navigator.clipboard` off the global, exactly as the app does,
  so what a copy claims is asserted against what actually reached the clipboard.
*/
Object.defineProperty(globalThis, "navigator", {
  value: {
    clipboard: {
      writeText: async (value) => {
        if (clipboardFails) throw new Error("clipboard refused");
        copied.push(value);
      },
    },
  },
  configurable: true,
});
const translate = () => ({
  t: (key, values) => `${key}:${values?.name ?? ""}`,
});
const sharedPackage = await import("@pi-desktop/shared");

const previewTarget = loadModule("../src/hooks/use-preview-target.ts", {
  react: React,
  "react-i18next": { useTranslation: translate },
  "@pi-desktop/shared": sharedPackage,
  "../stores/app-store": { useAppStore },
  "./use-chat-session-capability": { useChatSessionCapability: () => true },
  "../lib/remote-session-safety": loadModule("../src/lib/remote-session-safety.ts", {}),
  "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
  "../lib/api": {
    api: {
      listPluginViews: async () => state.pluginViews,
      listPlugins: async () => ({ plugins: [] }),
      fsOpen: async (path, mimeType, sessionId) =>
        calls.defaultBrowsers.push([path, mimeType, sessionId]),
      fsReveal: async (path, sessionId) => {
        if (revealFails) throw new Error("reveal refused");
        calls.reveals.push([path, sessionId]);
      },
      fsResolveRef: async (ref) => {
        calls.resolved.push(ref);
        return { match: nextMatch };
      },
    },
  },
  "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {
    "@pi-desktop/shared": sharedPackage,
    "./chat-link-scanner.ts": loadModule("../src/lib/chat-link-scanner.ts", {
      "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
    }),
    "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
  }),
  "../lib/open-http-url": { openHttpUrl: (...args) => calls.urls.push(args) },
  "../lib/work-panel-tabs": loadModule("../src/lib/work-panel-tabs.ts", {}),
});

const nativeCapability = loadModule("../src/hooks/use-chat-session-capability.ts", {
  "../lib/remote-session-safety": loadModule("../src/lib/remote-session-safety.ts", {}),
  "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
  "../stores/app-store": { useAppStore },
});

const { useChatFileMenu, useChatFileMenuItems } = loadModule(
  "../src/hooks/use-chat-file-menu.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: translate },
    "../components/icons": {
      IconBrowser: () => null,
      IconCopy: () => null,
      IconExternal: () => null,
      IconFolderOpen: () => null,
      IconGlobe: () => null,
    },
    "../lib/chat-links": {
      isHtmlFilePath: (path) => /\.html?$/i.test(path),
    },
    "../components/ContextMenu": {
      useContextMenu: () => ({
        contextMenu: null,
        openContextMenu: (_event, request) => calls.menus.push(request),
        closeContextMenu: () => {},
      }),
    },
    "./use-preview-target": previewTarget,
    "./use-chat-session-capability": nativeCapability,
  },
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function reset(match) {
  Object.values(calls).forEach((list) => list.splice(0, list.length));
  nextMatch = match;
  clipboardFails = false;
  revealFails = false;
}

/** The match the main process reports for a file of the project's main folder. */
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

/**
 * Render both hooks for one reference, then click it and run the menu item the
 * right-click would have offered. Both run inside a render, so no side effect
 * fires while React is rendering.
 */
async function openWithDestination(path, destination) {
  let open = null;
  function Harness() {
    open = previewTarget.useOpenChatFileRef();
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  assert.equal(typeof open, "function", "the hook returned a click handler");
  open(path, undefined, undefined, { destination });
  await flush();
}

test("the HTML menu exposes three open destinations as one submenu", () => {
  reset(projectMatch());
  let openFileMenu = null;
  function Harness() {
    openFileMenu = useChatFileMenu().openFileMenu;
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  openFileMenu({}, { path: "src/dir/a.html" });
  const menu = calls.menus[0].items;
  assert.deepEqual(menu.map((item) => item.id), [
    "open-with",
    "reveal-in-folder",
    "copy-full-path",
    "copy-relative-path",
  ]);
  assert.equal(menu[0].label, "chat.openWith:");
  assert.deepEqual(
    menu[0].submenu.map((item) => [item.id, item.label]),
    [
      ["open-with-file-manager", "chat.openWithFileManager:"],
      ["open-with-built-in-browser", "chat.openWithBuiltInBrowser:"],
      ["open-with-default-browser", "chat.openWithDefaultBrowser:"],
    ],
  );
});

test("non-HTML references offer Show in folder and copy actions without an open-with submenu", () => {
  reset(projectMatch());
  let openFileMenu = null;
  function Harness() {
    openFileMenu = useChatFileMenu().openFileMenu;
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  openFileMenu({}, { path: "src/dir/a.ts" });
  assert.deepEqual(calls.menus[0].items.map((item) => item.id), [
    "reveal-in-folder",
    "copy-full-path",
    "copy-relative-path",
  ]);
});

test("the File Manager opens the resolved project or scratch path", async () => {
  reset(projectMatch({ relativePath: "page.html", absolutePath: "C:/project/page.html" }));
  await openWithDestination("page.html", "file-manager");
  assert.deepEqual(calls.resolved, ["page.html"]);
  assert.equal(calls.tabs[0].location, "page.html");

  reset({
    root: "scratch",
    relativePath: "page.html",
    absolutePath: "C:/data/scratch/session-1/page.html",
    matchedBy: "exact-relative",
  });
  await openWithDestination("page.html", "file-manager");
  assert.equal(calls.tabs[0].location, "C:/data/scratch/session-1/page.html");
});

test("HTML can open in the embedded or default browser at its resolved address", async () => {
  reset(projectMatch({ relativePath: "page.html", absolutePath: "C:/project/page.html" }));
  await openWithDestination("page.html", "built-in-browser");
  assert.deepEqual(calls.urls, [["C:/project/page.html"]]);

  await openWithDestination("page.html", "default-browser");
  assert.deepEqual(calls.defaultBrowsers, [
    ["C:/project/page.html", undefined, "session-1"],
  ]);
});

test("an unresolved HTML reference is reported and opened nowhere", async () => {
  reset(null);
  await openWithDestination("missing.html", "built-in-browser");
  assert.deepEqual(calls.tabs, []);
  assert.deepEqual(calls.files, []);
  assert.deepEqual(calls.urls, []);
  assert.deepEqual(calls.defaultBrowsers, []);
  assert.deepEqual(calls.toasts.map(([message]) => message), [
    "chat.fileRefMissing:missing.html",
  ]);
});

/** Select the Show in folder item the right-click offers for a reference. */
async function revealRef(path) {
  let items = null;
  function Harness() {
    items = useChatFileMenuItems()({ path });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  const item = items.find((entry) => entry.id === "reveal-in-folder");
  assert.ok(item, "the reference offers Show in folder");
  assert.equal(item.label, "chat.revealFileInFolder:");
  item.onSelect();
  await flush();
}

test("Show in folder reveals the resolved absolute path", async () => {
  reset(projectMatch());
  await revealRef("a.ts");
  assert.deepEqual(calls.resolved, ["a.ts"]);
  assert.deepEqual(calls.reveals, [["C:/project/src/dir/a.ts", "session-1"]]);
  assert.deepEqual(calls.toasts, []);

  reset({
    root: "scratch",
    relativePath: "notes.md",
    absolutePath: "C:/data/scratch/session-1/notes.md",
    matchedBy: "exact-relative",
  });
  await revealRef("notes.md");
  assert.deepEqual(calls.reveals, [["C:/data/scratch/session-1/notes.md", "session-1"]]);
});

test("Show in folder reports a missing reference or a refused reveal", async () => {
  reset(null);
  await revealRef("missing.ts");
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.toasts.map(([message]) => message), [
    "chat.fileRefMissing:missing.ts",
  ]);

  reset(projectMatch());
  revealFails = true;
  await revealRef("a.ts");
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.toasts.map(([message]) => message), [
    "chat.fileRevealFailed:",
  ]);
});

/** Run one copy item of the reference menu on the reference it names. */
async function copyRef(path, kind) {
  let copy = null;
  let items = null;
  function Harness() {
    copy = previewTarget.useCopyChatFileRef();
    items = useChatFileMenuItems()({ path });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  const id = kind === "absolute" ? "copy-full-path" : "copy-relative-path";
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, "the reference offers the copy");
  copy(path, undefined, kind);
  await flush();
}

test("a project file copies its full address and its project-relative one", async () => {
  reset(projectMatch());
  copied.length = 0;
  await copyRef("src/dir/a.ts", "absolute");
  await copyRef("src/dir/a.ts", "relative");
  assert.deepEqual(copied, ["C:/project/src/dir/a.ts", "src/dir/a.ts"]);
  assert.deepEqual(
    calls.toasts.map(([message]) => message),
    ["chat.copied:", "chat.copied:"],
  );
});

test("a sibling folder file copies its full address and its own relative one", async () => {
  reset(
    projectMatch({
      relativePath: "lib/only-here.ts",
      absolutePath: "C:/project-second/lib/only-here.ts",
      projectRoot: { primary: false },
    }),
  );
  copied.length = 0;
  await copyRef("lib/only-here.ts", "absolute");
  await copyRef("lib/only-here.ts", "relative");
  assert.deepEqual(copied, [
    "C:/project-second/lib/only-here.ts",
    "lib/only-here.ts",
  ]);
});

test("a file outside the project has nothing relative to copy", async () => {
  reset({
    root: "scratch",
    relativePath: "notes.md",
    absolutePath: "C:/data/scratch/session-1/notes.md",
    matchedBy: "exact-relative",
  });
  copied.length = 0;
  await copyRef("notes.md", "absolute");
  await copyRef("notes.md", "relative");
  // The full address is still the file's own; the relative one is refused
  // instead of handing back the absolute path under that name.
  assert.deepEqual(copied, ["C:/data/scratch/session-1/notes.md"]);
  assert.deepEqual(
    calls.toasts.map(([message]) => message),
    ["chat.copied:", "chat.relativePathUnavailable:"],
  );
});

test("a refused clipboard reports itself", async () => {
  reset(projectMatch());
  copied.length = 0;
  clipboardFails = true;
  await copyRef("src/dir/a.ts", "absolute");
  assert.deepEqual(copied, []);
  assert.deepEqual(
    calls.toasts.map(([message]) => message),
    ["chat.copyFailed:"],
  );
});

const transcript = await readTranscriptSource();
const markdown = read("../src/components/Markdown.tsx");
const toolRow = read("../src/features/chat/transcript/ToolRow.tsx");
const toolDetails = read("../src/components/ToolDetails.tsx");
const shared = read("../src/features/chat/transcript/shared.tsx");

test("every transcript surface that names a file opens that item", () => {
  // The chip a user turn renders owns the same item its row does, next to the
  // thumbnail that names the same attachment a second way.
  assert.match(
    shared,
    /const \{ fileMenu, openFileMenu, closeFileMenu \} = useChatFileMenu\(\)/,
  );
  assert.match(shared, /onContextMenu=\{\(event\) => openFileMenu\(event, \{ path \}\)/);
  // An image attachment is the same chip as any other attachment now, so that
  // chip carries the file menu and the shared preview card hangs off it.
  assert.match(
    shared,
    /<ImageHoverCard src=\{dataUrl\} anchor=\{anchor\} onDismiss=\{dismiss\} \/>/,
  );
  assert.match(shared, /<ContextMenu state=\{fileMenu\} onClose=\{closeFileMenu\} \/>/);
  // A tool row's summary and a tool result's file and match lists name files
  // the same way, so they open the same item where the reference is rendered.
  assert.match(toolRow, /previewTarget\?\.kind === "file"/);
  assert.match(toolRow, /openFileMenu\(event, \{ path: previewTarget\.path \}\)/);
  assert.match(toolDetails, /openFileMenu\(event, \{ path: rel \}\)/);
  // Markdown owns one surface for its whole tree, because its blocks are
  // memoized and the references are spread across them.
  assert.match(markdown, /const fileMenuItems = useChatFileMenuItems\(\)/);
  assert.match(
    markdown,
    /<MarkdownFileMenuContext\.Provider value=\{openMarkdownFileMenu\}>/,
  );
  assert.match(markdown, /<ContextMenu state=\{fileMenu\} onClose=\{closeFileMenu\} \/>/);
  // Inline code, a file link, and a local image each hand their own reference
  // to that surface; `./` and `../` keep the markdown base beside the path.
  assert.match(markdown, /openFileMenu\(event, \{ path: text \?\? target\.path, baseDir \}\)/);
  assert.match(markdown, /openFileMenu\(event, \{ path: ref, baseDir \}\)/);
  assert.match(markdown, /openFileMenu\(event, \{ path: localRef, baseDir \}\)/);
  assert.match(markdown, /onContextMenu=\{onLocalContextMenu\}/);
  // A local image that cannot be shown inline keeps a chip, and both carry the
  // menu only when local tools are allowed and the reference resolved to a file.
  assert.match(
    markdown,
    /const onLocalContextMenu =\s*localToolsAllowed && localRef && openFileMenu/,
  );
});

test("HTTP URLs keep their own menu instead of the file open submenu", () => {
  const menu = read("../src/hooks/use-chat-file-menu.tsx");
  // The submenu only recognizes HTML paths, and an HTTP link keeps its own
  // external/work-panel/copy menu.
  assert.match(menu, /isHtmlFilePath\(path\)/);
  assert.ok(markdown.includes('if (!/^https?:\\/\\//i.test(href)) {'));
});

test("the reference labels ship in the catalogs the menu reads", () => {
  const en = read("../../../packages/i18n/src/locales/en/index.ts");
  const zhCN = read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(en, /openWith: "Open with"/);
  assert.match(en, /openWithFileManager: "File Manager"/);
  assert.match(en, /openWithBuiltInBrowser: "Built-in browser"/);
  assert.match(en, /openWithDefaultBrowser: "Default browser"/);
  assert.match(en, /defaultBrowserOpenFailed:/);
  assert.match(en, /copyFullPath: "Copy full path"/);
  assert.match(en, /revealFileInFolder: "Show in folder"/);
  assert.match(zhCN, /revealFileInFolder: "在文件夹中打开"/);
  assert.match(en, /copyRelativePath: "Copy relative path"/);
  assert.match(zhCN, /openWith: "打开方式"/);
  assert.match(zhCN, /openWithFileManager: "文件管理器"/);
  assert.match(zhCN, /openWithBuiltInBrowser: "内置浏览器"/);
  assert.match(zhCN, /openWithDefaultBrowser: "默认浏览器"/);
  assert.match(zhCN, /defaultBrowserOpenFailed:/);
  assert.match(zhCN, /copyFullPath: "复制完整地址"/);
  assert.match(zhCN, /copyRelativePath: "复制相对地址"/);
});

test("remote workspace references retain copy actions but never offer local open or reveal actions", () => {
  const before = state.sessions;
  state.sessions = [{ id: state.activeSessionId, remoteWorkspace: { hostKey: "ssh", path: "/work/app" } }];
  let items;
  function Harness() { items = useChatFileMenuItems()({ path: "index.html" }); return null; }
  renderToStaticMarkup(React.createElement(Harness));
  assert.deepEqual(items.map(item => item.id), ["copy-full-path", "copy-relative-path"]);
  state.sessions = before;
});

test("a directory reference browses the file manager instead of the file view (issue #2113)", async () => {
  reset({
    root: "workspace",
    relativePath: "examples",
    absolutePath: "C:/project/examples",
    matchedBy: "exact-relative",
    target: "directory",
    projectRoot: { primary: true },
  });
  await openWithDestination("examples", undefined);
  assert.deepEqual(calls.tabs, [{
    id: "plugin:pi.file-manager/manager",
    kind: "plugin",
    resource: "pi.file-manager/manager",
    location: "examples",
  }]);
  assert.deepEqual(calls.files, []);
  assert.deepEqual(calls.toasts, []);

  // A directory outside the project's primary folder travels by its absolute
  // path, exactly like a file from a sibling folder does.
  reset({
    root: "scratch",
    relativePath: "run",
    absolutePath: "C:/data/scratch/session-1/run",
    matchedBy: "exact-relative",
    target: "directory",
    sessionScratch: true,
  });
  await openWithDestination("run", undefined);
  assert.deepEqual(calls.tabs.map((tab) => tab.location), ["C:/data/scratch/session-1/run"]);
  assert.deepEqual(calls.files, []);
});

test("a directory reference without a loadable file manager reports and never opens the file view", async () => {
  const viewsBefore = state.pluginViews;
  state.pluginViews = [];
  try {
    reset({
      root: "workspace",
      relativePath: "examples",
      absolutePath: "C:/project/examples",
      matchedBy: "exact-relative",
      target: "directory",
      projectRoot: { primary: true },
    });
    await openWithDestination("examples", undefined);
    assert.deepEqual(calls.tabs, []);
    assert.deepEqual(calls.files, []);
    assert.deepEqual(calls.toasts.map(([message]) => message), ["chat.fileManagerUnavailable:"]);
  } finally {
    state.pluginViews = viewsBefore;
  }
});
