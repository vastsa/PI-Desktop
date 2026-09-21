import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Drain promises and their continuations, without timing-dependent sleeps.
const settled = () => new Promise(setImmediate);

function harness() {
  let state = null;
  let visible = false;
  const roots = [];
  const loads = [];
  const shown = [];
  const published = [];
  let invalidations = 0;
  const pane = {
    getState: () => state,
    getWebContents: () => null,
    invalidateNavigation: () => { invalidations += 1; },
    setBounds: () => {},
    setVisible(value) {
      visible = value;
      if (value) shown.push(state?.url);
    },
    navigateAndWait(target, root) {
      const done = deferred();
      const load = { target, root, fail: () => done.resolve(null), finish() {
        state = { url: target, title: target, isLoading: false };
        done.resolve(state);
      } };
      loads.push(load);
      return done.promise;
    },
    dispose: () => { state = null; visible = false; },
  };
  const host = new BrowserHost({
    pane,
    isPluginLoaded: () => true,
    getFileRoot(sessionId) {
      const root = deferred();
      roots.push({ sessionId, ...root });
      return root.promise;
    },
    onState: (value) => published.push(value),
  });
  const surface = (show = true) => host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: show,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  const hole = () => host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  surface();
  hole();
  return {
    host, roots, loads, shown, published, surface, hole,
    get visible() { return visible; },
    get invalidations() { return invalidations; },
  };
}

async function openPreview(h, sessionId, path) {
  h.host.setChromeSession(sessionId);
  const request = h.host.previewWorkspaceFile(sessionId, path, `/projects/${sessionId}`);
  await settled();
  h.loads.at(-1).finish();
  await request;
}

test("opening two session previews and switching back never reveals the previous session while loading", async () => {
  const h = harness();
  await openPreview(h, "A", "A.html");
  assert.equal(h.visible, true);
  // A background tool prepares B's page without stealing A's preview.
  await h.host.previewWorkspaceFile("B", "B.html", "/projects/B");
  assert.equal(h.loads.length, 1);
  h.surface(false);
  h.host.setChromeSession("B");
  h.surface();
  h.hole();
  h.host.setGuestVisible("pi.browser", true);
  assert.equal(h.visible, false, "A must stay hidden during B's root lookup");
  const before = h.shown.length;
  h.roots.at(-1).resolve("/projects/B");
  await settled();
  assert.equal(h.visible, false, "A must stay hidden during B's document load");
  assert.equal(h.loads.at(-1).target, "B.html");
  h.loads.at(-1).finish();
  await settled();
  assert.equal(h.visible, true);
  assert.deepEqual(h.shown.slice(before), ["B.html"]);

  h.host.setChromeSession("A");
  assert.equal(h.visible, false);
  h.roots.at(-1).resolve("/projects/A");
  await settled();
  h.loads.at(-1).finish();
  await settled();
  assert.equal(h.shown.at(-1), "A.html");
  assert.equal(h.visible, true);
});

test("an older root lookup cannot navigate over a newer session", async () => {
  const h = harness();
  h.host.rememberLocation("B", "B.html");
  h.host.rememberLocation("C", "C.html");
  h.host.setChromeSession("B");
  const old = h.roots.at(-1);
  h.host.setChromeSession("C");
  h.roots.at(-1).resolve("/projects/C");
  await settled();
  h.loads.at(-1).finish();
  await settled();
  old.resolve("/projects/B");
  await settled();
  assert.deepEqual(h.loads.map((load) => load.target), ["C.html"]);
  assert.equal(h.shown.at(-1), "C.html");
});

test("a previous session's load completion cannot reveal its guest while the new root is pending", async () => {
  const h = harness();
  h.host.setChromeSession("A");
  const pending = h.host.navigate({ path: "A.html" }, "A");
  h.roots.at(-1).resolve("/projects/A");
  await settled();
  h.host.rememberLocation("B", "B.html");
  h.host.setChromeSession("B");
  assert.equal(h.invalidations, 2, "each session binding invalidates native events");
  h.loads[0].finish();
  await pending;
  assert.equal(h.visible, false);
  assert.deepEqual(h.published, [], "stale navigation must not publish A as current");
  h.roots.at(-1).resolve("/projects/B");
  await settled();
  h.loads.at(-1).finish();
  await settled();
  assert.equal(h.shown.at(-1), "B.html");
});

test("a session without a remembered preview cannot expose the previous guest", async () => {
  const h = harness();
  await openPreview(h, "A", "A.html");
  h.host.setChromeSession("empty");
  h.surface();
  h.hole();
  h.host.setGuestVisible("pi.browser", true);
  assert.equal(h.visible, false);
  assert.equal(h.roots.length, 0);
});

test("same-session navigation supersedes a pending restore and keeps existing content during normal navigation", async () => {
  const h = harness();
  await openPreview(h, "A", "A.html");
  const next = h.host.navigate({ url: "https://fixture.invalid/new" }, "A");
  assert.equal(h.visible, true, "normal navigation within A does not blank A's loaded page");
  h.roots.at(-1).resolve("/projects/A");
  await settled();
  h.loads.at(-1).finish();
  await next;
  assert.equal(h.shown.at(-1), "https://fixture.invalid/new");
  h.host.setChromeSession("B");
  h.host.setChromeSession("A");
  const restore = h.roots.at(-1);
  const newest = h.host.navigate({ path: "newest.html" }, "A");
  h.roots.at(-1).resolve("/projects/A");
  await settled();
  h.loads.at(-1).finish();
  await newest;
  const count = h.loads.length;
  restore.resolve("/projects/A");
  await settled();
  assert.equal(h.loads.length, count);
  assert.equal(h.shown.at(-1), "newest.html");
});

test("closing the panel during a load keeps it hidden when the load completes", async () => {
  const h = harness();
  h.host.setChromeSession("A");
  const pending = h.host.previewWorkspaceFile("A", "A.html", "/projects/A");
  await settled();
  h.surface(false);
  h.loads.at(-1).finish();
  await pending;
  assert.equal(h.visible, false);
  h.surface();
  assert.equal(h.visible, true);
});

test("disposing the guest invalidates pending roots and prevents its recreation", async () => {
  const h = harness();
  h.host.rememberLocation("A", "A.html");
  h.host.setChromeSession("A");
  h.host.disposeGuest();
  h.roots.at(-1).resolve("/projects/A");
  await settled();
  assert.deepEqual(h.loads, []);
  assert.equal(h.visible, false);
});

test("a failed replacement load leaves the previous session hidden", async () => {
  const h = harness();
  await openPreview(h, "A", "A.html");
  h.host.rememberLocation("B", "B.html");
  h.host.setChromeSession("B");
  h.roots.at(-1).resolve("/projects/B");
  await settled();
  h.loads.at(-1).fail();
  await settled();
  h.hole();
  assert.equal(h.visible, false);
});
