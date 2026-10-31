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
  const roots = [], loads = [], panes = [], published = [], reveals = [];
  const createPane = (onState) => {
    let state = null;
    const pane = {
      visible: false, disposed: false,
      setWindow: () => {}, setBounds: () => {},
      setVisible(value) { this.visible = value; },
      getState: () => state, getWebContents: () => null,
      invalidateNavigation: () => {},
      navigateAndWait(target, fileRoot) {
        const done = deferred();
        loads.push({ target, fileRoot, pane, finish() {
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
    getFileRoots(sessionId) {
      const done = deferred(); roots.push({ sessionId, ...done });
      return done.promise.then(root => root ? [root, "/scratch/" + sessionId] : ["/scratch/" + sessionId]);
    },
    onState: (state) => published.push(state),
    onRevealView: (sessionId, tabId) => reveals.push({ sessionId, tabId }),
  });
  const surface = (visible = true) => host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  surface();
  host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return { host, roots, loads, panes, published, reveals, surface };
}
async function open(h, sessionId, tabId, url) {
  h.host.setChromeSession(sessionId, tabId, url);
  h.roots.at(-1).resolve(`/projects/${sessionId}`);
  await settled(); h.loads.at(-1).finish(); await settled();
}

test("BrowserPreview prepares a new resource tab without navigating or rewriting the current tab", async () => {
  const h = harness(); await open(h, "A", "one", "A.html");
  const preview = h.host.previewFile();
  await settled();
  assert.equal(h.loads.length, 1, "preview must wait for the resource-tab owner");
  assert.equal(h.host.getState().url, "A.html");
  await preview;
  await open(h, "A", "preview", "preview.html");
  h.host.setChromeSession("A", "one", "A.html");
  assert.equal(h.host.getState().url, "A.html");
  assert.equal(h.loads.length, 2, "switching back must reuse the page");
});

test("background navigation runs in that session's last selected tab", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  await open(h, "B", "b", "B.html");
  h.host.setChromeSession("A", "a");
  const navigation = h.host.navigate({ url: "https://fixture.invalid/new-b" }, "B");
  h.roots.at(-1).resolve("/projects/B"); await settled();
  assert.equal(h.loads.at(-1).target, "https://fixture.invalid/new-b");
  h.loads.at(-1).finish();
  const state = await navigation;
  assert.equal(state.sessionId, "B");
  assert.equal(state.tabId, "b");
  assert.equal(h.host.getState().url, "A.html");
  h.host.setChromeSession("B", "b");
  assert.equal(h.host.getState().url, state.url);
  assert.equal(h.loads.length, 3, "selecting an already running page must not reload it");
  h.host.dispose();
});

test("the first background navigation creates an isolated tab without UI mounting", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  const navigation = h.host.navigate({ url: "https://fixture.invalid/first-c" }, "C");
  assert.equal(h.roots.at(-1).sessionId, "C");
  h.roots.at(-1).resolve("/projects/C"); await settled();
  h.loads.at(-1).finish();
  const state = await navigation;
  assert.equal(state.sessionId, "C");
  assert.equal(state.tabId, "plugin:pi.browser/browser");
  assert.equal(h.host.getState().url, "A.html");
  assert.equal(h.panes.at(-1).visible, false);
  h.host.dispose();
});

test("a temporary preview uses its own scratch even while a project session is visible", async () => {
  const h = harness();
  await open(h, "project", "project-tab", "project.html");
  h.host.setChromeSession("temporary", "scratch-tab", "/scratch/temporary/animation.html");
  assert.equal(h.roots.at(-1).sessionId, "temporary");
  h.roots.at(-1).resolve(null);
  await settled();
  assert.equal(h.loads.at(-1).fileRoot, "/scratch/temporary");
  h.loads.at(-1).finish();
  await settled();
  h.host.setChromeSession("project", "project-tab");
  assert.equal(h.host.getState().url, "project.html");
  h.host.dispose();
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

test("Browser reveal opens the calling session and waits for its visible view", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/current");
  h.surface(false);

  let resolved = false;
  const reveal = h.host.reveal("A").then(() => { resolved = true; });
  assert.deepEqual(h.reveals, [{ sessionId: "A", tabId: "a" }]);
  h.surface(false);
  assert.equal(resolved, false, "a hidden view must not release the operation");
  h.surface(true);
  await reveal;
  assert.equal(resolved, true);
});

test("switching sessions reveals an isolated Browser page and preserves the previous session", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/a");
  h.surface(false);

  const reveal = h.host.reveal("B");
  assert.deepEqual(h.reveals, [{ sessionId: "B", tabId: undefined }]);
  h.host.setChromeSession("B", "plugin:pi.browser/browser");
  h.surface(true);
  await reveal;
  assert.equal(h.host.getContext().sessionId, "B");

  const navigation = h.host.navigate({ url: "https://fixture.invalid/b" }, "B");
  h.roots.at(-1).resolve("/projects/B");
  await settled();
  h.loads.at(-1).finish();
  assert.equal((await navigation).url, "https://fixture.invalid/b");

  h.host.setChromeSession("A", "a");
  assert.equal(h.host.getState().url, "https://fixture.invalid/a");
});

test("Browser reveal returns UNAVAILABLE when the session view never appears", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const timedOut = assert.rejects(h.host.reveal("B"), { code: "UNAVAILABLE" });
  t.mock.timers.tick(5_000);
  await timedOut;
  assert.deepEqual(h.reveals, [{ sessionId: "B", tabId: undefined }]);
});

test("Browser reveal never steals focus from a different session", async () => {
  const h = harness();
  await open(h, "A", "a", "https://fixture.invalid/current");
  h.surface(false);
  const reveal = h.host.reveal("B");
  assert.deepEqual(h.reveals, [{ sessionId: "B", tabId: undefined }]);
  assert.equal(h.host.getContext().sessionId, "A");
  h.host.disposeGuest();
  await assert.rejects(reveal, (error) => error?.code === "UNAVAILABLE");
});

test("unscoped plugin browser operations still require a visible Browser view", async () => {
  const h = harness(); await open(h, "A", "a", "A.html");
  assert.equal(h.host.getStateForPlugin().url, "A.html");
  h.surface(false);
  const unavailable = (error) => error?.code === "UNAVAILABLE";

  assert.equal(h.host.getState().url, "A.html", "host UI state remains readable");
  assert.throws(() => h.host.getStateForPlugin(), unavailable);
  assert.throws(() => h.host.action("reload"), unavailable);
  assert.throws(() => h.host.openExternal(), unavailable);
  assert.throws(() => h.host.console(), unavailable);
  await assert.rejects(h.host.navigate({ url: "https://fixture.invalid/hidden" }), unavailable);
  await assert.rejects(h.host.snapshot(), unavailable);
  await assert.rejects(h.host.screenshot(), unavailable);
  await assert.rejects(h.host.click("uid"), unavailable);
  await assert.rejects(h.host.fill("uid", "text"), unavailable);
  await assert.rejects(h.host.evaluate("document.title"), unavailable);
  await assert.rejects(h.host.cdpCommand("Page.enable"), unavailable);
  assert.equal(h.loads.length, 1, "hidden navigation must not reach the page");
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
