import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const settled = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const roots = [], loads = [], panes = [], published = [];
  const createPane = (onState) => {
    let state = null;
    const pane = {
      visible: false, disposed: false,
      setWindow: () => {}, setBounds: () => {},
      setVisible(value) { this.visible = value; },
      getState: () => state, getWebContents: () => null,
      invalidateNavigation: () => {},
      navigateAndWait(target) {
        const done = deferred();
        loads.push({ target, pane, finish() {
          state = { url: target, title: target, isLoading: false, canGoBack: false, canGoForward: false };
          onState(state); done.resolve(state);
        }, fail: () => done.resolve(null) });
        return done.promise;
      },
      dispose() { this.visible = false; this.disposed = true; },
    };
    panes.push(pane);
    return pane;
  };
  const host = new BrowserHost({
    createPane, isPluginLoaded: () => true,
    getFileRoot(sessionId) {
      const done = deferred(); roots.push({ sessionId, ...done }); return done.promise;
    },
    onState: (state) => published.push(state),
  });
  const surface = (visible = true) => host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  surface();
  host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return { host, roots, loads, panes, published, surface };
}
async function open(h, sessionId, tabId, url) {
  h.host.setChromeSession(sessionId, tabId, url);
  h.roots.at(-1).resolve(`/projects/${sessionId}`);
  await settled(); h.loads.at(-1).finish(); await settled();
}

test("BrowserPreview prepares a new resource tab without navigating or rewriting the current tab", async () => {
  const h = harness(); await open(h, "A", "one", "A.html");
  const preview = h.host.previewWorkspaceFile("A", "preview.html", "/projects/A");
  await settled();
  assert.equal(h.loads.length, 1, "preview must wait for the resource-tab owner");
  assert.equal(h.host.getState().url, "A.html");
  await preview;
  await open(h, "A", "preview", "preview.html");
  h.host.setChromeSession("A", "one", "A.html");
  assert.equal(h.host.getState().url, "A.html");
  assert.equal(h.loads.length, 2, "switching back must reuse the page");
});

test("background navigation targets that session's last selected tab", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  await open(h, "B", "b", "B.html");
  h.host.setChromeSession("A", "a");
  await h.host.navigate({ url: "https://fixture.invalid/new-b" }, "B");
  h.loads[1].finish(); // A late native state update cannot overwrite the queued URL.
  assert.equal(h.host.getState().url, "A.html");
  assert.equal(h.loads.length, 2);
  h.host.setChromeSession("B", "b", "B.html");
  h.roots.at(-1).resolve("/projects/B"); await settled();
  assert.equal(h.loads.at(-1).target, "https://fixture.invalid/new-b");
  h.loads.at(-1).finish(); await settled();
  assert.equal(h.host.getState().url, "https://fixture.invalid/new-b");
  h.host.setChromeSession("D", "d", "old-d.html");
  h.roots.at(-1).resolve("/projects/D"); await settled();
  const pendingLoad = h.loads.at(-1);
  h.host.setChromeSession("A", "a");
  await h.host.navigate({ url: "https://fixture.invalid/new-d" }, "D");
  pendingLoad.finish(); await settled();
  h.host.setChromeSession("D", "d");
  h.roots.at(-1).resolve("/projects/D"); await settled();
  assert.equal(h.loads.at(-1).target, "https://fixture.invalid/new-d");
  h.loads.at(-1).finish(); await settled();
  await h.host.navigate({ url: "https://fixture.invalid/queued" }, "C");
  await open(h, "C", "c", "old.html");
  assert.equal(h.host.getState().url, "https://fixture.invalid/queued");
  h.host.setChromeSession("E"); // A session may exist without a concrete resource tab.
  h.host.setChromeSession("A", "a");
  await h.host.navigate({ url: "https://fixture.invalid/first-e" }, "E");
  await open(h, "E", "e", "old-e.html");
  assert.equal(h.host.getState().url, "https://fixture.invalid/first-e");
  h.host.setChromeSession("C", "blank");
  assert.equal(h.host.getState(), null);
});

test("an empty tab exposes no previous address or native page", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  h.host.setChromeSession("A", "blank");
  h.host.setGuestVisible("pi.browser", true);
  assert.equal(h.host.getState(), null);
  assert.equal(h.panes.some((pane) => pane.visible), false);
  assert.equal(h.published.at(-1).url, "");
});

test("a delayed root lookup can finish in its own background tab without taking over the active page", async () => {
  const h = harness(); h.host.setChromeSession("A", "a", "A.html");
  const older = h.roots.at(-1);
  await open(h, "B", "b", "B.html");
  older.resolve("/projects/A"); await settled(); h.loads.at(-1).finish(); await settled();
  assert.equal(h.host.getState().url, "B.html");
  assert.equal(h.loads.at(-1).pane.visible, false);
  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "A.html");
});

test("same-tab navigation supersedes an older request and retains sibling pages", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  const older = h.host.navigate({ url: "https://fixture.invalid/older" }, "A");
  const oldRoot = h.roots.at(-1);
  const newer = h.host.navigate({ url: "https://fixture.invalid/newer" }, "A");
  h.roots.at(-1).resolve("/projects/A"); await settled(); h.loads.at(-1).finish(); await newer;
  oldRoot.resolve("/projects/A"); await older;
  assert.equal(h.loads.length, 2);
  assert.equal(h.host.getState().url, "https://fixture.invalid/newer");
  await open(h, "B", "b", "B.html");
  const fromOldChrome = h.host.navigate({ url: "https://fixture.invalid/a-late" }, "A", "a");
  h.roots.at(-1).resolve("/projects/A"); await settled(); h.loads.at(-1).finish(); await fromOldChrome;
  assert.equal(h.host.getState().url, "B.html");
  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "https://fixture.invalid/a-late");
});

test("closing the panel keeps a pending page hidden until the panel returns", async () => {
  const h = harness(); h.host.setChromeSession("A", "a", "A.html");
  h.roots.at(-1).resolve("/projects/A"); await settled(); h.surface(false);
  h.loads.at(-1).finish(); await settled();
  assert.equal(h.panes[0].visible, false);
  h.surface(); assert.equal(h.panes[0].visible, true);
});

test("closing a tab and disposing the host cancel pending ownership and release pages", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  h.host.setChromeSession("A", "pending", "pending.html"); const root = h.roots.at(-1);
  h.host.closeTab("A", "pending"); root.resolve("/projects/A"); await settled();
  assert.equal(h.loads.length, 1);
  h.host.setChromeSession("A", "a"); assert.equal(h.host.getState().url, "A.html");
  h.host.disposeGuest(); assert.equal(h.panes.every((pane) => pane.disposed), true);
  assert.equal(h.host.getState(), null);
});

test("a failed tab never exposes a sibling page", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  h.host.setChromeSession("B", "b", "B.html"); h.roots.at(-1).resolve("/projects/B"); await settled();
  h.loads.at(-1).fail(); await settled();
  assert.equal(h.panes.some((pane) => pane.visible), false);
  assert.notEqual(h.host.getState()?.url, "A.html");
});
