import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relative, imports) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(id => { assert.ok(Object.hasOwn(imports, id), id); return imports[id]; }, module.exports, module);
  return module.exports;
}
const tabs = load("../src/lib/work-panel-tabs.ts", {});
const manager = { pluginId: "pi.file-manager", viewId: "manager" };
function fixture() {
  const calls = { opened: [], revealed: [], reviewed: [], tabs: [], toasts: [], refs: [] };
  const state = { activeSessionId: "s", workspace: { path: "D:/project" }, sessions: [{ id: "s" }], pluginViews: [manager],
    openWorkPanelTab: tab => calls.tabs.push(tab), showToast: (...args) => calls.toasts.push(args) };
  const host = {
    match: { root: "workspace", relativePath: "src/a.ts", absolutePath: "D:/project/src/a.ts", matchedBy: "exact-absolute", projectRoot: { primary: true } },
    loaded: [manager], onResolve: () => {},
  };
  const useAppStore = Object.assign(selector => selector(state), { getState: () => state });
  const { useReviewFileOpen } = load("../src/hooks/use-review-file-open.ts", {
    "react-i18next": { useTranslation: () => ({ t: key => key }) },
    "../stores/app-store": { useAppStore }, "../lib/work-panel-tabs": tabs,
    "../lib/api": { api: {
      fsResolveRef: async (...args) => { calls.refs.push(args); await host.onResolve(); return { match: host.match }; },
      fsOpen: async (...args) => { calls.opened.push(args); if (host.failOpen) throw Error("OS failure"); },
      fsReveal: async (...args) => { calls.revealed.push(args); if (host.failReveal) throw Error("OS reveal failure"); },
      workspaceReviewOpenFile: async input => { calls.reviewed.push(input); if (host.failReviewed) throw Error("OS open failure"); },
      listPluginViews: async () => host.loaded,
    } },
  });
  const file = { root: "D:/project", path: "src/a.ts", entries: [{ message: {}, change: { snapshotId: "native-snapshot" } }] };
  return { calls, state, host, file, hook: () => useReviewFileOpen(file, "s") };
}
test("disabled/missing file manager cannot open or silently enable a plugin", async () => {
  const f = fixture(); f.state.pluginViews = [];
  assert.equal(f.hook().canOpenInternal, false);
  await f.hook().openFile("internal");
  assert.deepEqual(f.calls.tabs, []); assert.deepEqual(f.calls.refs, []);
});
test("review opens an exact current file in the loaded file manager", async () => {
  const f = fixture(); assert.equal(f.hook().canOpenInternal, true);
  await f.hook().openFile("internal");
  assert.deepEqual(f.calls.refs, [["D:/project/src/a.ts", "s"]]);
  assert.deepEqual(f.calls.tabs, [tabs.fileManagerPluginTab("src/a.ts")]);
});
test("worktree and secondary project files keep their absolute identity", async () => {
  for (const isolated of [true, false]) {
    const f = fixture();
    if (isolated) f.state.sessions[0].worktree = { path: "D:/branch" };
    else f.host.match.projectRoot.primary = false;
    f.host.match.absolutePath = "D:/branch/src/a.ts";
    await f.hook().openFile("internal");
    assert.equal(f.calls.tabs[0].location, "D:/branch/src/a.ts");
  }
});
test("external open passes the resolved path and owning session to the OS boundary", async () => {
  const f = fixture(); f.state.pluginViews = [];
  f.host.match.absolutePath = "D:/branch/src/a.ts";
  await f.hook().openFile("external");
  assert.deepEqual(f.calls.opened, [["D:/branch/src/a.ts", undefined, "s"]]);
});
test("missing, forbidden and fuzzy same-named matches never open another file", async () => {
  for (const matchedBy of [null, "basename", "path-suffix"]) {
    const f = fixture(); if (matchedBy) f.host.match.matchedBy = matchedBy; else f.host.match = null;
    await f.hook().openFile("external");
    assert.deepEqual(f.calls.opened, []); assert.equal(f.calls.toasts.length, 1);
  }
});
test("plugin unloading during lookup cannot open a stale plugin tab", async () => {
  const f = fixture(); f.host.loaded = [];
  await f.hook().openFile("internal");
  assert.deepEqual(f.calls.tabs, []); assert.equal(f.calls.toasts.length, 1);
});
test("session/project switching while lookup is in flight discards the result", async () => {
  for (const destination of ["internal", "external", "folder"]) {
    for (const changed of ["session", "workspace"]) {
      const f = fixture();
      f.host.onResolve = () => { if (changed === "session") f.state.activeSessionId = "other"; else f.state.workspace = { path: "D:/other" }; };
      await f.hook().openFile(destination);
      assert.deepEqual(f.calls.tabs, []); assert.deepEqual(f.calls.opened, []); assert.deepEqual(f.calls.revealed, []); assert.deepEqual(f.calls.toasts, []);
    }
  }
});
test("unknown legacy delegate provenance and remote workspaces are disabled", async () => {
  const f = fixture(); delete f.file.root; f.file.entries[0].message.parentToolCallId = "task";
  assert.equal(f.hook().canOpenFile, false); await f.hook().openFile("external");
  assert.deepEqual(f.calls.opened, []);
  f.file.root = "D:/project"; f.state.workspace.remote = {};
  assert.equal(f.hook().canOpenFile, false);
});
test("Windows review roots become canonical file references before authorized lookup", async () => {
  const cases = [
    ["\\\\?\\D:\\project", "D:/project/src/a.ts"],
    ["D:\\project", "D:/project/src/a.ts"],
    ["\\\\?\\UNC\\server\\share\\project", "//server/share/project/src/a.ts"],
    ["/project", "/project/src/a.ts"],
  ];
  for (const [root, expected] of cases) {
    const f = fixture(); f.file.root = root;
    await f.hook().openFile("external");
    assert.equal(f.calls.refs[0][0], expected);
  }
});
test("OS failures remain visible to the owning session", async () => {
  const f = fixture(); f.host.failOpen = true;
  await f.hook().openFile("external");
  assert.equal(f.calls.toasts[0][0], "panel.review.openError");
});
test("absolute outside-workspace paths are resolved directly, never appended to the workspace", async () => {
  for (const path of ["D:/outside/file.txt", "/tmp/file.txt", "\\\\?\\D:\\outside\\file.txt"]) {
    const f = fixture(); f.file.path = path;
    await f.hook().openFile("folder");
    assert.equal(f.hook().outside, true);
    assert.equal(f.hook().canOpenInternal, false);
    assert.deepEqual(f.calls.refs, []);
    assert.deepEqual(f.calls.reviewed, [{ sessionId: "s", snapshotId: "native-snapshot", action: "folder" }]);
    await f.hook().openFile("internal"); assert.deepEqual(f.calls.tabs, []);
  }
});
test("open folder reveals the exact resolved file in the system file manager without a plugin", async () => {
  const f = fixture(); f.state.pluginViews = [];
  f.host.match.absolutePath = "D:/branch/src/a.ts";
  await f.hook().openFile("folder");
  assert.deepEqual(f.calls.revealed, [["D:/branch/src/a.ts", "s"]]);
  assert.deepEqual(f.calls.opened, []); assert.deepEqual(f.calls.tabs, []);
});
test("folder action rejects unavailable/fuzzy paths and reports OS failures", async () => {
  for (const match of [null, { matchedBy: "basename" }, { matchedBy: "path-suffix" }]) {
    const f = fixture(); f.host.match = match;
    await f.hook().openFile("folder");
    assert.deepEqual(f.calls.revealed, []); assert.equal(f.calls.toasts.length, 1);
  }
  const f = fixture(); f.host.failReveal = true;
  await f.hook().openFile("folder");
  assert.equal(f.calls.toasts[0][0], "panel.review.openError");
});
