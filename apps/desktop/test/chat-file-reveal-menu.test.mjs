/**
 * A file the conversation already recognised is a file the user can act on.
 *
 * Opening it is one click, so the only destination left for the pointer path is
 * the file's own folder in the system file manager. Every surface that names a
 * file offers it — a turn's chip, an inline code span, a markdown link, a local
 * image — and all of them reveal through the same completion a click uses, so a
 * shorthand that resolved to nothing reports that instead of revealing a
 * lookalike file in another folder (ADR 0262/0263).
 *
 * The destination half is asserted behaviorally: the real hooks run against a
 * recorded store and stubbed host replies, because the contract is the address
 * a reveal hands the host, not the shape of the code that builds it.
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
  reveals: [],
  tabs: [],
  files: [],
  urls: [],
  toasts: [],
  resolved: [],
  menus: [],
};

const state = {
  workspace: { path: "C:/project" },
  activeSessionId: "session-1",
  pluginViews: [{ pluginId: "pi.file-manager", viewId: "manager" }],
  openFileInWorkPanel: (...args) => calls.files.push(args),
  openUrlInWorkPanel: (...args) => calls.urls.push(args),
  openWorkPanelTab: (tab) => calls.tabs.push(tab),
  showToast: (...args) => calls.toasts.push(args),
};

let nextMatch = null;
let revealFails = false;


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

const previewTarget = loadModule("../src/hooks/use-preview-target.ts", {
  react: React,
  "react-i18next": { useTranslation: translate },
  "../stores/app-store": { useAppStore: (selector) => selector(state) },
  "../lib/api": {
    api: {
      fsResolveRef: async (ref) => {
        calls.resolved.push(ref);
        return { match: nextMatch };
      },
      fsReveal: async (path) => {
        if (revealFails) throw new Error("host refused to reveal");
        calls.reveals.push(path);
      },
    },
  },
  "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {}),
  "../lib/open-http-url": { openHttpUrl: (...args) => calls.urls.push(args) },
  "../lib/work-panel-tabs": loadModule("../src/lib/work-panel-tabs.ts", {}),
});

const { useChatFileMenu, useChatFileMenuItems } = loadModule(
  "../src/hooks/use-chat-file-menu.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: translate },
    "../components/icons": { IconCopy: () => null, IconFolderOpen: () => null },
    "../components/ContextMenu": {
      useContextMenu: () => ({
        contextMenu: null,
        openContextMenu: (_event, request) => calls.menus.push(request),
        closeContextMenu: () => {},
      }),
    },
    "./use-preview-target": previewTarget,
  },
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function reset(match) {
  Object.values(calls).forEach((list) => list.splice(0, list.length));
  nextMatch = match;
  revealFails = false;
  clipboardFails = false;
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
async function clickAndReveal(path) {
  let open = null;
  let items = null;
  function Harness() {
    open = previewTarget.useOpenChatFileRef();
    items = useChatFileMenuItems()({ path });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  assert.equal(typeof open, "function", "the hook returned a click handler");
  const item = items.find((entry) => entry.id === "reveal-in-folder");
  assert.ok(item, "every file reference offers its folder");
  open(path);
  await flush();
  item.onSelect("");
  await flush();
}

test("a project file is revealed at the address the click opens", async () => {
  reset(projectMatch());
  await clickAndReveal("src/dir/a.ts");
  // Completion ran for both actions, so neither can act on a different file.
  assert.deepEqual(calls.resolved, ["src/dir/a.ts", "src/dir/a.ts"]);
  assert.equal(calls.tabs[0].location, "src/dir/a.ts");
  assert.deepEqual(calls.reveals, ["src/dir/a.ts"]);
  assert.deepEqual(calls.toasts, []);
});

test("a sibling folder file is revealed by absolute path, as it is opened", async () => {
  reset(
    projectMatch({
      relativePath: "lib/only-here.ts",
      absolutePath: "C:/project-second/lib/only-here.ts",
      projectRoot: { primary: false },
    }),
  );
  await clickAndReveal("lib/only-here.ts");
  assert.equal(calls.tabs[0].location, "C:/project-second/lib/only-here.ts");
  assert.deepEqual(calls.reveals, ["C:/project-second/lib/only-here.ts"]);
});

test("a scratch or attachment file is revealed by absolute path", async () => {
  reset({
    root: "scratch",
    relativePath: "notes.md",
    absolutePath: "C:/data/scratch/session-1/notes.md",
    matchedBy: "exact-relative",
  });
  await clickAndReveal("notes.md");
  assert.equal(calls.files[0][0], "C:/data/scratch/session-1/notes.md");
  assert.deepEqual(calls.reveals, ["C:/data/scratch/session-1/notes.md"]);
});

test("a reference nothing answers reports itself and reveals nothing", async () => {
  reset(null);
  await clickAndReveal("missing-helper.js");
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.files, []);
  assert.deepEqual(calls.tabs, []);
  assert.deepEqual(
    calls.toasts.map(([message]) => message),
    ["chat.fileRefMissing:missing-helper.js", "chat.fileRefMissing:missing-helper.js"],
  );
});

test("a refused reveal is reported instead of failing silently", async () => {
  reset(projectMatch());
  revealFails = true;
  await clickAndReveal("src/dir/a.ts");
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(
    calls.toasts.map(([message]) => message),
    ["chat.fileRevealFailed:"],
  );
});

test("the menu a reference opens carries the reveal and both copies", () => {
  reset(projectMatch());
  let openFileMenu = null;
  function Harness() {
    openFileMenu = useChatFileMenu().openFileMenu;
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  openFileMenu({}, { path: "src/dir/a.ts" });
  assert.deepEqual(
    calls.menus.map((menu) => menu.items.map((item) => [item.id, item.label])),
    [
      [
        ["reveal-in-folder", "chat.revealFileInFolder:"],
        ["copy-full-path", "chat.copyFullPath:"],
        ["copy-relative-path", "chat.copyRelativePath:"],
      ],
    ],
  );
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
  assert.match(
    shared,
    /onContextMenu=\{\(event\) => openFileMenu\(event, \{ path: attachment\.ref \}\)/,
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
  assert.match(markdown, /openFileMenu\(event, \{ path: rel, baseDir \}\)/);
  assert.match(markdown, /openFileMenu\(event, \{ path: localRef, baseDir \}\)/);
  assert.match(markdown, /onContextMenu=\{onLocalContextMenu\}/);
  // A local image that cannot be shown inline keeps a chip, and both carry the
  // menu only when the reference actually resolved to a file.
  assert.match(markdown, /const onLocalContextMenu =\s*localRef && openFileMenu/);
});

test("a URL never reaches the reveal", () => {
  const menu = read("../src/hooks/use-chat-file-menu.tsx");
  // The item is file-only by construction: it is built where the reference is a
  // path, and an HTTP link keeps its own external/work-panel/copy menu.
  assert.match(menu, /useRevealChatFileRef\(\)/);
  assert.doesNotMatch(menu, /openHttpUrl|browserOpenExternal/);
  // An HTTP link is not a file on disk, so it never grows this item; it keeps
  // the menu it already has.
  assert.ok(markdown.includes('if (!/^https?:\\/\\//i.test(href)) {'));
});

test("the reference labels ship in the catalogs the menu reads", () => {
  const en = read("../../../packages/i18n/src/locales/en/index.ts");
  const zhCN = read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(en, /revealFileInFolder: "Show in folder"/);
  assert.match(en, /fileRevealFailed: "Could not show the file in its folder\."/);
  assert.match(en, /copyFullPath: "Copy full path"/);
  assert.match(en, /copyRelativePath: "Copy relative path"/);
  assert.match(zhCN, /revealFileInFolder: "在文件夹中显示"/);
  assert.match(zhCN, /fileRevealFailed: "无法在文件夹中打开该文件。"/);
  assert.match(zhCN, /copyFullPath: "复制完整地址"/);
  assert.match(zhCN, /copyRelativePath: "复制相对地址"/);
});
