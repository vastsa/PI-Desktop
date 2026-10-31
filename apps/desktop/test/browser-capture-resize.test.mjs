import assert from "node:assert/strict";
import { once } from "node:events";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Only Electron is replaced: exercise the production Host, Pane and CDP path.
// Chromium restores the viewport saved when capture starts, even if a native
// bounds update arrives before capture finishes.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class View {
    children = [];
    parent = null;
    visible = true;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    addChildView(view) { this.children.push(view); view.parent = this; }
    removeChildView(view) { this.children.splice(this.children.indexOf(view), 1); view.parent = null; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    setVisible(visible) { this.visible = visible; }
  }
  export class BrowserWindow {
    static instances = [];
    contentView = new View();
    destroyed = false;
    constructor(options) { this.size = [options.width, options.height]; BrowserWindow.instances.push(this); }
    getContentSize() { return this.size; }
    setContentSize(width, height) { this.size = [width, height]; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  export class WebContentsView extends View {
    static instances = [];
    constructor() {
      super();
      const wc = Object.assign(new EventEmitter(), {
        id: WebContentsView.instances.length + 1,
        url: "", destroyed: false, viewport: { width: 0, height: 0 },
        captures: [],
        layoutSize: { width: 800, height: 6000 },
        async loadURL(url) {
          this.emit("did-start-navigation", {}, url, false, true);
          this.url = url;
          this.emit("did-navigate", {}, url);
        },
        getURL() { return this.url; },
        getTitle: () => "fixture", isLoading: () => false,
        isDestroyed() { return this.destroyed; },
        throttled: true,
        getBackgroundThrottling() { return this.throttled; },
        setBackgroundThrottling(value) { this.throttled = value; },
        close() {
          if (this.destroyed) throw new Error("guest already destroyed");
          this.destroyed = true;
          this.emit("destroyed");
        },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      wc.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        async sendCommand(method, params) {
          if (method === "Page.getLayoutMetrics") {
            return { cssContentSize: { ...wc.layoutSize } };
          }
          if (method !== "Page.captureScreenshot") return {};
          const savedViewport = { ...wc.viewport };
          let resolve, reject;
          const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
          wc.captures.push({ params, resolve, reject });
          wc.emit("capture-start");
          try {
            await pending;
            return { data: "fixture-image" };
          } finally { wc.viewport = savedViewport; }
        },
      });
      this.webContents = wc;
      wc.once("destroyed", () => { this.webContents = undefined; });
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.webContents.viewport = { width: bounds.width, height: bounds.height };
    }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView, BrowserWindow } = await import("electron");

async function harness(t) {
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => new BrowserPane(onState, onOpenUrl),
    isPluginLoaded: () => true, getFileRoots: async () => [], onState: () => {},
  });
  const children = [];
  host.setWindow({ isDestroyed: () => false, contentView: {
    children,
    addChildView(view) { children.push(view); },
    removeChildView(view) { children.splice(children.indexOf(view), 1); },
  } });
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 0, y: 0, width: 1200, height: 900 } });
  const resize = (width, height) => host.setGuestHole("pi.browser", { x: 0, y: 0, width, height });
  resize(800, 500);
  host.setChromeSession("session", "first");
  await host.navigate({ url: "https://fixture.invalid/first" }, "session", "first");
  t.after(() => host.dispose());
  return { host, resize, children, view: WebContentsView.instances.at(-1), wc: WebContentsView.instances.at(-1).webContents };
}

function paintedBounds(view) {
  const own = view.getBounds();
  if (!view.parent) return own;
  const parent = view.parent.getBounds();
  return {
    x: parent.x + own.x, y: parent.y + own.y,
    width: Math.min(own.width, parent.width - own.x),
    height: Math.min(own.height, parent.height - own.y),
  };
}

test("full-page screenshot scales both dimensions to provider-safe limits", async (t) => {
  const { host, wc } = await harness(t);
  for (const [layoutSize, expectedScale] of [
    [{ width: 800, height: 6000 }, 2048 / 6000],
    [{ width: 4000, height: 6000 }, 1280 / 4000],
  ]) {
    wc.layoutSize = layoutSize;
    const started = once(wc, "capture-start");
    const capture = host.screenshot({ fullPage: true });
    await started;
    assert.deepEqual(wc.captures.at(-1).params.clip, {
      x: 0,
      y: 0,
      width: layoutSize.width,
      height: layoutSize.height,
      scale: expectedScale,
    });
    wc.captures.at(-1).resolve();
    await capture;
  }
});

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} stays inside the relocated panel before capture finishes`, async (t) => {
    const { host, wc, view } = await harness(t);
    const started = once(wc, "capture-start");
    const capture = raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot({ fullPage: true });
    await started;
    // A maximize/restore can move the panel while the tool's screenshot is
    // still pending. The content must never remain above the conversation.
    const relocated = { x: 1100, y: 42, width: 620, height: 430 };
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: relocated });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: 620, height: 430 });
    const during = paintedBounds(view);
    assert.deepEqual(wc.viewport, { width: 800, height: 500 }, "capture viewport remains stable");
    wc.captures[0].resolve();
    await capture;
    assert.deepEqual(during, relocated, "move and clip the native guest before awaiting capture");
    assert.deepEqual(paintedBounds(view), relocated);
    assert.deepEqual(wc.viewport, { width: 620, height: 430 });
  });
}

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} restores the latest panel size`, async (t) => {
    const { host, resize, wc } = await harness(t);
    const started = once(wc, "capture-start");
    const request = raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot({ fullPage: true });
    await started;
    resize(910, 590);
    resize(960, 620);
    wc.captures[0].resolve();
    await request;
    assert.deepEqual(wc.viewport, { width: 960, height: 620 });
    assert.equal(wc.captures.length, 1, "resizing must not repeat the screenshot");
  });
}

test("a failed capture releases resizing and does not poison the next capture", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const failed = assert.rejects(host.screenshot(), /fixture capture failure/);
  await started;
  resize(940, 600);
  wc.captures[0].reject(new Error("fixture capture failure"));
  await failed;
  assert.deepEqual(wc.viewport, { width: 940, height: 600 });
  const nextStarted = once(wc, "capture-start");
  const next = host.screenshot();
  await nextStarted;
  wc.captures[1].resolve();
  assert.equal((await next).data, "fixture-image");
});

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} timeout releases the queue for the next capture`, async (t) => {
    const { host, wc } = await harness(t);
    const capture = () => raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot();
    const setTimeout = globalThis.setTimeout;
    let expire;
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.equal(delay, 30_000);
      expire = () => callback(...args);
      return 1;
    };
    t.after(() => { globalThis.setTimeout = setTimeout; });
    const failed = assert.rejects(
      capture(),
      (error) => {
        assert.match(error.message, /browser screenshot timed out after 30000ms/);
        assert.equal(error.code, "TIMEOUT");
        return true;
      },
    );
    await once(wc, "capture-start");
    expire();

    await failed;
    assert.equal(wc.debugger.isAttached(), false, "detach the stalled CDP session");
    wc.captures[0].reject(new Error("debugger detached"));
    const nextStarted = once(wc, "capture-start");
    const next = capture();
    await nextStarted;
    wc.captures[1].resolve();
    assert.equal((await next).data, "fixture-image");
  });
}

test("overlapping capture APIs serialize per page, not across sibling tabs", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const nextStarted = once(wc, "capture-start");
  const next = host.cdpCommand("Page.captureScreenshot", { format: "png" });
  host.setChromeSession("session", "second");
  await host.navigate({ url: "https://fixture.invalid/second" }, "session", "second");
  const sibling = WebContentsView.instances.at(-1).webContents;
  const siblingStarted = once(sibling, "capture-start");
  const siblingShot = host.screenshot();
  await siblingStarted;
  assert.equal(wc.captures.length, 1, "the first page must not capture concurrently");
  sibling.captures[0].resolve();
  await siblingShot;
  wc.captures[0].resolve();
  await first;
  await nextStarted;
  assert.equal(wc.captures.length, 2, "queued capture must retain its original page");
  host.setChromeSession("session", "first");
  resize(920, 610);
  wc.captures[1].resolve();
  await next;
  assert.deepEqual(wc.viewport, { width: 920, height: 610 });
  assert.equal(sibling.captures.length, 1);
});

test("closing a tab rejects its queued capture without capturing a replacement", async (t) => {
  const { host, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const queued = assert.rejects(host.screenshot(), /browser guest is not available/);
  host.closeTab("session", "first");
  host.setChromeSession("session", "replacement");
  await host.navigate({ url: "https://fixture.invalid/replacement" }, "session", "replacement");
  wc.captures[0].resolve();
  await first;
  await queued;
  assert.equal(wc.captures.length, 1);
  assert.equal(WebContentsView.instances.at(-1).webContents.captures.length, 0);
});

test("hiding and restoring a captured page keeps its presentation isolated from sibling tabs", async (t) => {
  const { host, children, view, wc } = await harness(t);
  const surface = view.parent;
  const started = once(wc, "capture-start");
  const capture = host.screenshot();
  await started;
  host.setChromeSession("session", "second");
  await host.navigate({ url: "https://fixture.invalid/second" }, "session", "second");
  assert(!children.includes(surface));
  assert.equal(surface.parent.visible, true, "the page stays rendered in the hidden backing host");
  const relocated = { x: 960, y: 70, width: 530, height: 400 };
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: relocated });
  host.setGuestHole("pi.browser", { x: 0, y: 0, width: 530, height: 400 });
  host.setChromeSession("session", "first");
  assert.deepEqual(paintedBounds(view), relocated);
  assert.equal(surface.visible, true);
  assert.equal(children.at(-1), surface);
  wc.captures[0].resolve();
  await capture;
  assert.deepEqual(wc.viewport, { width: 530, height: 400 });
  host.closeTab("session", "first");
  assert(!children.includes(surface));
  assert.equal(surface.children.length, 0);
  assert.equal(wc.destroyed, true);
});

test("a destroyed native guest can be resized, replaced and disposed safely", async (t) => {
  const { host, resize, wc, view, children } = await harness(t);
  const previousSurface = view.parent;
  wc.close();
  assert.equal(view.webContents, undefined, "Electron clears a destroyed guest handle");
  resize(930, 620);
  await host.navigate({ url: "https://fixture.invalid/recreated" }, "session", "first");
  const replacement = WebContentsView.instances.at(-1);
  assert.notEqual(replacement, view);
  assert(!children.includes(previousSurface));
  assert.equal(children.length, 1);
  assert.deepEqual(replacement.webContents.viewport, { width: 930, height: 620 });
  replacement.webContents.close();
  host.dispose();
  host.dispose();
  assert.equal(children.length, 0);
});

test("capture completion after native guest destruction preserves the original capture result", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const capture = host.screenshot();
  await started;
  wc.close();
  resize(900, 620);
  wc.captures[0].resolve();
  assert.equal((await capture).data, "fixture-image");
  host.dispose();
});

test("background backing windows stay hidden and release with the last parked page", async (t) => {
  const { host, children, view, wc } = await harness(t);
  host.setChromeSurface(null);
  const backing = BrowserWindow.instances.at(-1);
  assert.equal(backing.destroyed, false);
  assert(backing.contentView.children.includes(view.parent));
  assert.equal(children.length, 0, "hidden pages cannot cover the main window");
  host.closeSession("session");
  assert.equal(wc.destroyed, true);
  assert.equal(backing.destroyed, true);
  assert.equal(backing.contentView.children.length, 0);
});

test("page-local viewport work restores throttling and resizing on failure", async (t) => {
  const { host, wc, resize } = await harness(t);
  const paneSurface = WebContentsView.instances.at(-1).parent;
  host.setChromeSurface(null);
  const started = once(wc, "capture-start");
  const failed = assert.rejects(host.screenshot({}, "session"), /fixture failure/);
  await started;
  assert.equal(wc.getBackgroundThrottling(), false);
  wc.captures[0].reject(new Error("fixture failure"));
  await failed;
  assert.equal(wc.getBackgroundThrottling(), true);
  assert.equal(paneSurface.parent.children.includes(paneSurface), true);
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 0, y: 0, width: 1200, height: 900 } });
  resize(920, 610);
  assert.deepEqual(wc.viewport, { width: 920, height: 610 });
});
