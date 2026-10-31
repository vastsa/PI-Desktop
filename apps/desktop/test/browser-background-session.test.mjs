import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

// Electron/WebContents is the external edge. BrowserHost and BrowserCdp use
// their production wiring, including per-page snapshot uids and deadlines.
function harness() {
  const panes = [], roots = [], loads = [], published = [], presentation = [], reveals = [];
  let enabled = true;
  const host = new BrowserHost({
    createPane(onState) {
      let state = null;
      let attached = false;
      const commands = [];
      const wc = {
        id: panes.length + 1,
        clicks: 0,
        value: "",
        isDestroyed: () => pane.disposed,
        getURL: () => state?.url ?? "",
        getTitle: () => state?.title ?? "",
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => attached,
          attach() { attached = true; },
          detach() { attached = false; },
          async sendCommand(method, input = {}) {
            commands.push({ method, input });
            if (method === "Accessibility.getFullAXTree") return {
              nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: wc.getTitle() }, backendDOMNodeId: wc.id }],
            };
            if (method === "DOM.getBoxModel") return { model: { content: wc.hiddenBoxOffset ? [-140, -876, -100, -876, -100, -836, -140, -836] : [0, 0, 40, 0, 40, 40, 0, 40] } };
            if (method === "DOM.resolveNode") return { object: { objectId: `input-${wc.id}` } };
            if (method === "Input.dispatchMouseEvent" && input.type === "mouseReleased" && input.x >= 0 && input.y >= 0) wc.clicks += 1;
            if (method === "Runtime.callFunctionOn" && input.functionDeclaration.includes("getBoundingClientRect")) return { result: { value: { x: 20, y: 20 } } };
            if (method === "Runtime.callFunctionOn") wc.value = input.arguments[0].value;
            if (method === "Runtime.evaluate") return { result: { value: wc.getTitle() } };
            if (method === "Page.captureScreenshot") return { data: Buffer.from(wc.getTitle()).toString("base64") };
            return {};
          },
        }),
      };
      const pane = {
        disposed: false,
        visible: false,
        wc,
        commands,
        setWindow() {},
        setBounds() {},
        setVisible(visible) { this.visible = visible; },
        getState: () => state,
        getWebContents: () => pane.disposed ? null : wc,
        captureScreenshot: (run) => run(wc),
        withStableViewport: (run) => run(wc),
        navigateAndWait(url, root) {
          const pending = deferred();
          loads.push({ url, root, pane, finish() {
            state = { url, title: url, isLoading: false, canGoBack: false, canGoForward: false };
            onState(state);
            pending.resolve(state);
          } });
          return pending.promise;
        },
        dispose() { this.disposed = true; this.visible = false; },
      };
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => enabled,
    getFileRoots(sessionId) {
      const pending = deferred();
      roots.push({ sessionId, ...pending });
      return pending.promise;
    },
    onState: (state) => published.push(state),
    onPresentationState: (state) => presentation.push(state),
    onRevealView: (sessionId, tabId) => reveals.push({ sessionId, tabId }),
  });
  const surface = (visible = true) => host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  surface();
  host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return { host, panes, roots, loads, published, presentation, reveals, surface, disable: () => { enabled = false; } };
}

async function open(h, sessionId, tabId, url) {
  h.host.setChromeSession(sessionId, tabId, url);
  h.roots.at(-1).resolve([`/projects/${sessionId}`]);
  await settled();
  h.loads.at(-1).finish();
  await settled();
  return h.panes.at(-1);
}

test("background Browser actions stay on the invoking session while another page is visible", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const a = await open(h, "A", "a", "https://fixture.invalid/a");
  const b = await open(h, "B", "b", "https://fixture.invalid/b");
  const snapshot = await h.host.snapshot("A");
  assert.equal(snapshot.url, "https://fixture.invalid/a");
  assert.match(snapshot.tree, /fixture.invalid\/a/);
  await h.host.click("e1", "A");
  await h.host.fill("e1", "A's draft", "A");
  assert.equal(await h.host.evaluate("document.title", "A"), "https://fixture.invalid/a");
  const shot = await h.host.screenshot({}, "A");
  assert.equal(Buffer.from(shot.data, "base64").toString(), "https://fixture.invalid/a");
  await h.host.cdpCommand("Page.enable", {}, "A");
  assert.deepEqual(h.host.console(10, "A"), { messages: [] });
  assert.equal(a.wc.clicks, 1);
  assert.equal(a.wc.value, "A's draft");
  assert.equal(b.wc.clicks, 0);
  assert.equal(b.wc.value, "");
  assert.equal(h.host.getState().sessionId, "B");
  assert.equal(a.visible, false);
  assert.equal(b.visible, true);
  assert.deepEqual(h.reveals, []);
});

test("hiding or unmounting browser chrome does not interrupt an owned page", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const a = await open(h, "A", "a", "https://fixture.invalid/a");
  h.surface(false);
  h.host.setChromeSurface(null);
  assert.equal((await h.host.snapshot("A")).url, "https://fixture.invalid/a");
  await h.host.fill("e1", "retained draft", "A");
  assert.equal(h.host.getStateForPlugin("A").tabId, "a");
  assert.equal(a.disposed, false);
  assert.equal(a.visible, false);
  h.surface();
  h.host.setChromeSession("A", "a");
  assert.equal(a.wc.value, "retained draft");
  assert.equal(h.loads.length, 1, "showing the side panel must not reload its page");
});

test("background navigation executes immediately and never rewrites the visible session", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  await open(h, "A", "a", "https://fixture.invalid/a");
  await open(h, "B", "b", "https://fixture.invalid/b");
  const navigation = h.host.navigate({ url: "https://fixture.invalid/new-a" }, "A");
  assert.equal(h.roots.at(-1).sessionId, "A");
  h.roots.at(-1).resolve(["/projects/A"]);
  await settled();
  assert.equal(h.loads.at(-1).url, "https://fixture.invalid/new-a");
  h.loads.at(-1).finish();
  assert.equal((await navigation).tabId, "a");
  assert.equal(h.host.getState().url, "https://fixture.invalid/b");
  assert.equal((await h.host.snapshot("A")).url, "https://fixture.invalid/new-a");
});

test("unknown, closed and disabled targets fail without borrowing another session's page", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  await open(h, "A", "a", "https://fixture.invalid/a");
  const b = await open(h, "B", "b", "https://fixture.invalid/b");
  await assert.rejects(h.host.snapshot("missing"), { code: "UNAVAILABLE" });
  h.host.closeSession("A");
  await assert.rejects(h.host.snapshot("A"), { code: "UNAVAILABLE" });
  await assert.rejects(h.host.click("e1", "A"), { code: "UNAVAILABLE" });
  h.disable();
  await assert.rejects(h.host.snapshot("B"), { code: "UNAVAILABLE" });
  assert.equal(b.commands.length, 0);
});

test("renderer reload detaches only presentation and keeps page identity and inputs", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const a = await open(h, "A", "a", "https://fixture.invalid/a");
  await h.host.snapshot("A");
  await h.host.fill("e1", "unsaved input", "A");
  h.host.detachPresentation();
  assert.equal(h.host.getState(), null);
  assert.deepEqual(h.host.getPages("A").map((page) => page.tabId), ["a"]);
  assert.deepEqual(h.host.getPages("B"), []);
  assert.equal((await h.host.snapshot("A")).url, "https://fixture.invalid/a");
  h.surface();
  h.host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  h.host.setChromeSession("A", "a", "https://fixture.invalid/a");
  assert.equal(h.panes.length, 1);
  assert.equal(h.loads.length, 1);
  assert.equal(a.wc.value, "unsaved input");
  h.host.closeTab("A", "a");
  assert.deepEqual(h.host.getPages("A"), []);
});

test("a preview creates and loads its own background page before a side-panel tab mounts", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  await open(h, "B", "b", "https://fixture.invalid/b");
  const preview = h.host.openTab({ path: "/projects/A/preview.html" }, "A");
  assert.equal(h.roots.at(-1).sessionId, "A");
  h.roots.at(-1).resolve(["/projects/A"]);
  await settled();
  h.loads.at(-1).finish();
  const result = await preview;
  assert.equal(result.state.sessionId, "A");
  assert.equal(result.state.tabId, result.tabId);
  assert.equal(h.host.getState().sessionId, "B");
  assert.equal((await h.host.snapshot("A")).url, "/projects/A/preview.html");
  h.host.setChromeSession("A", result.tabId, "/projects/A/preview.html");
  assert.equal(h.loads.length, 2);
});

test("an established connection stays on its page when the user views another tab", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const first = await open(h, "A", "first", "https://fixture.invalid/first");
  await h.host.snapshot("A");
  const second = await open(h, "A", "second", "https://fixture.invalid/second");
  await h.host.click("e1", "A");
  assert.equal(first.wc.clicks, 1);
  assert.equal(second.wc.clicks, 0);
  assert.equal(h.host.getState().tabId, "second");
  h.host.closeTab("A", "first");
  await assert.rejects(h.host.snapshot("A"), { code: "UNAVAILABLE" });
});

test("background page metadata never repaints the visible browser chrome", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  await open(h, "A", "a", "https://fixture.invalid/a");
  await open(h, "B", "b", "https://fixture.invalid/b");
  assert.equal(h.presentation.at(-1)?.sessionId, "B", "foreground state reaches browser chrome");
  h.presentation.length = 0;
  const navigation = h.host.navigate({ url: "https://fixture.invalid/new-a" }, "A");
  h.roots.at(-1).resolve(["/projects/A"]);
  await settled();
  h.loads.at(-1).finish();
  await navigation;
  assert.equal(h.published.at(-1).sessionId, "A", "renderer retains the originating tab metadata");
  assert.deepEqual(h.presentation, [], "B's chrome must not repaint or report A's bounds");
});

test("hidden native-view offsets cannot send a Browser click outside the page", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const a = await open(h, "A", "a", "https://fixture.invalid/a");
  await h.host.snapshot("A");
  await open(h, "B", "b", "https://fixture.invalid/b");
  a.wc.hiddenBoxOffset = true;
  await h.host.click("e1", "A");
  assert.equal(a.wc.clicks, 1, "click must use the target element's page-relative point");
});
