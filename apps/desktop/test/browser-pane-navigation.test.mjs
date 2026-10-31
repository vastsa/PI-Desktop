import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Electron is the external boundary; all navigation and timeout logic below
// runs in the production BrowserPane, without opening a native window.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {
    openedPaths: [],
    openPath(path) { this.openedPaths.push(path); return Promise.resolve(""); },
    openExternal() { return Promise.resolve(); },
  };
  export class View {
    children = [];
    addChildView(view) { this.children.push(view); }
    removeChildView(view) { this.children.splice(this.children.indexOf(view), 1); }
    setVisible() {}
    setBounds() {}
  }
  export class BrowserWindow {
    contentView = new View();
    destroyed = false;
    constructor(options) { this.size = [options.width, options.height]; }
    getContentSize() { return this.size; }
    setContentSize(width, height) { this.size = [width, height]; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  export class WebContentsView {
    static instances = [];
    constructor() {
      this.bounds = { x: 0, y: 0, width: 0, height: 0 };
      this.webContents = Object.assign(new EventEmitter(), {
        url: "https://fixture.invalid/previous",
        mainFrame: { processId: 7, routingId: 11 },
        pendingLoads: [],
        loadURL(url) {
          return new Promise((resolve, reject) => {
            this.pendingLoads.push({ url, resolve, reject });
          });
        },
        getURL() { return this.url; },
        getTitle: () => "fixture",
        isLoading: () => false,
        isDestroyed: () => false,
        close: () => {},
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      WebContentsView.instances.push(this);
    }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible() {}
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserPane, normalizeUrl, resolveLocalFile } = await import("../electron/main/browser-view.ts");
const { WebContentsView, shell } = await import("electron");
const settled = () => new Promise(setImmediate);

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pane = new BrowserPane(() => {});
  // The production class creates its native guest lazily at the first request.
  const request = pane.navigateAndWait("https://fixture.invalid/new", null, 100);
  const wc = WebContentsView.instances.at(-1).webContents;
  return { pane, wc, request };
}

test("address-bar host and port inputs normalize to HTTP without accepting other schemes", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("localhost:3000/index.html"), "http://localhost:3000/index.html");
  assert.equal(normalizeUrl("example.com:8080"), "http://example.com:8080/");
  assert.equal(normalizeUrl("127.0.0.1:3000"), "http://127.0.0.1:3000/");
  assert.equal(normalizeUrl("example.com"), "http://example.com/");
  assert.equal(normalizeUrl("http://localhost:3000/index.html"), "http://localhost:3000/index.html");
  assert.equal(normalizeUrl("file:///tmp/demo.html"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("custom:8080"), null);
});

test("submitting a localhost address with a workspace root loads and publishes the HTTP URL", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "browser-host-port-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  const request = pane.navigateAndWait("localhost:3000/index.html", root);
  const wc = WebContentsView.instances.at(-1).webContents;
  assert.equal(wc.pendingLoads[0].url, "http://localhost:3000/index.html");
  assert.equal(published.at(-1).url, "http://localhost:3000/index.html");
  wc.url = "http://localhost:3000/index.html";
  wc.pendingLoads.shift().resolve();
  assert.equal((await request).url, "http://localhost:3000/index.html");
});

test("timing out a new preview does not return the previous document as ready", async (t) => {
  const { request, wc } = harness(t);
  wc.pendingLoads[0].resolve(); // An old document finishing cannot satisfy this load.
  await settled();
  t.mock.timers.tick(100);
  assert.equal(await request, null);
});

test("a rejected navigation does not return the previous document as ready", async (t) => {
  const { pane, wc, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  wc.loadURL = async (url) => {
    wc.emit("did-start-navigation", {}, url, false, true);
    wc.emit("did-navigate", {}, wc.url); // Late commit of the preceding document.
    throw new Error("fixture load failure");
  };
  assert.equal(await pane.navigateAndWait("https://fixture.invalid/failed"), null);
});

test("a completed navigation returns its actual page, including redirects", async (t) => {
  const { pane, wc, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  wc.loadURL = async (url) => {
    wc.emit("did-start-navigation", {}, url, false, true);
    wc.url = "https://fixture.invalid/redirected";
    wc.emit("did-redirect-navigation", {}, wc.url, false, true);
  };
  const state = await pane.navigateAndWait("https://fixture.invalid/new");
  assert.equal(state.url, "https://fixture.invalid/redirected");
});

test("an invalid target cannot mark the previous document ready", async (t) => {
  const { pane, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  assert.equal(await pane.navigateAndWait("javascript:alert(1)"), null);
  await settled();
});

test("address-bar file inputs and page links can open existing files outside the workspace", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-browser-outside-"));
  t.after(() => { pane.dispose(); rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }); });
  mkdirSync(join(root, "pages"));
  const insideFile = join(root, "pages", "demo.html");
  const outsideFile = join(outside, "demo.html");
  writeFileSync(insideFile, "<h1>Inside</h1>");
  writeFileSync(outsideFile, "<h1>Outside</h1>");
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));

  const allowed = pane.navigateAndWait(pathToFileURL(insideFile).href, root);
  const wc = WebContentsView.instances.at(-1).webContents;
  assert.equal(wc.pendingLoads.at(-1).url, pathToFileURL(realpathSync(insideFile)).href);
  wc.url = pathToFileURL(realpathSync(insideFile)).href;
  wc.pendingLoads.shift().resolve();
  await allowed;

  const allowedAbsolute = pane.navigateAndWait(insideFile, root);
  assert.equal(wc.pendingLoads.at(-1).url, pathToFileURL(realpathSync(insideFile)).href);
  wc.pendingLoads.shift().resolve();
  await allowedAbsolute;

  const outsideUrl = pathToFileURL(outsideFile).href;
  const allowedOutsideUrl = pane.navigateAndWait(outsideUrl, root);
  assert.equal(wc.pendingLoads.at(-1).url, pathToFileURL(realpathSync(outsideFile)).href);
  wc.url = pathToFileURL(realpathSync(outsideFile)).href;
  wc.pendingLoads.shift().resolve();
  assert.equal((await allowedOutsideUrl).url, pathToFileURL(realpathSync(outsideFile)).href);

  const allowedOutsideAbsolute = pane.navigateAndWait(outsideFile, root);
  assert.equal(wc.pendingLoads.at(-1).url, pathToFileURL(realpathSync(outsideFile)).href);
  wc.pendingLoads.shift().resolve();
  assert.equal((await allowedOutsideAbsolute).url, pathToFileURL(realpathSync(outsideFile)).href);
  pane.openExternal();
  assert.equal(shell.openedPaths.at(-1), realpathSync(outsideFile));

  assert.equal(resolveLocalFile(outsideFile, root), null,
    "workspace-scoped BrowserPreview resolution must remain restricted");

  const willNavigate = wc.listeners("will-navigate")[0];
  assert.ok(willNavigate, "top-level navigation guard is installed");
  let outsidePrevented = false;
  willNavigate({ preventDefault() { outsidePrevented = true; } }, outsideUrl);
  assert.equal(outsidePrevented, false, "an existing outside file link is allowed");

  let missingPrevented = false;
  willNavigate({ preventDefault() { missingPrevented = true; } },
    pathToFileURL(join(outside, "missing.html")).href);
  assert.equal(missingPrevented, true, "a missing outside file remains blocked");

  let directoryPrevented = false;
  willNavigate({ preventDefault() { directoryPrevented = true; } }, pathToFileURL(outside).href);
  assert.equal(directoryPrevented, true, "a directory is not a previewable file");

  wc.url = "https://fixture.invalid/page";
  let webPagePrevented = false;
  willNavigate({ preventDefault() { webPagePrevented = true; } }, outsideUrl);
  assert.equal(webPagePrevented, true, "a web page cannot navigate outside the workspace");

  let remoteAuthorityPrevented = false;
  willNavigate({ preventDefault() { remoteAuthorityPrevented = true; } },
    `file://fileserver${outsideFile}`);
  assert.equal(remoteAuthorityPrevented, true, "remote file authorities are not local files");

  assert.equal(await pane.navigateAndWait(`../${outside.split("/").at(-1)}/demo.html`, root), null,
    "relative address-bar paths remain inside the workspace");
});

test("a missing local file on a blank tab publishes an error without creating a guest", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-browser-missing-"));
  const missingFile = join(tempRoot, "missing.html");
  const missingUrl = pathToFileURL(missingFile).href;
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  try {
    const count = WebContentsView.instances.length;
    assert.equal(await pane.navigateAndWait(missingUrl, "/projects/demo"), null);
    assert.equal(WebContentsView.instances.length, count);
    assert.deepEqual(published.at(-1), {
      url: missingUrl, title: "", isLoading: false,
      loadError: "LOCAL_FILE_NOT_ALLOWED", canGoBack: false, canGoForward: false,
    });
    assert.equal(await pane.navigateAndWait(missingFile, "/projects/demo"), null);
    assert.equal(WebContentsView.instances.length, count);
    assert.deepEqual(published.at(-1), {
      url: missingFile, title: "", isLoading: false,
      loadError: "LOCAL_FILE_NOT_ALLOWED", canGoBack: false, canGoForward: false,
    });
  } finally {
    pane.dispose();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("late native navigation events cannot publish after the session is invalidated", async () => {
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  const first = pane.navigateAndWait("https://fixture.invalid/first");
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = "https://fixture.invalid/first";
  wc.pendingLoads.shift().resolve();
  await first;
  pane.invalidateNavigation();
  const second = pane.navigateAndWait("https://fixture.invalid/second");
  wc.url = "https://fixture.invalid/second";
  wc.pendingLoads.shift().resolve();
  await second;
  assert.equal(published.at(-1).url, "https://fixture.invalid/second");
  published.length = 0;

  wc.emit("did-navigate", {}, "https://fixture.invalid/first");
  wc.emit("did-fail-load", {}, -3, "aborted", "https://fixture.invalid/first", true);
  assert.deepEqual(published, []);

  wc.emit("did-navigate", {}, "https://fixture.invalid/second");
  assert.equal(published.length, 1);
  assert.equal(published[0].url, "https://fixture.invalid/second");
});


async function loadedPage() {
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  const request = pane.navigateAndWait("https://fixture.invalid/page");
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = "https://fixture.invalid/page";
  wc.pendingLoads.shift().resolve();
  await request;
  assert.equal(published[0].isLoading, true);
  published.length = 0;
  return { pane, wc, published };
}

for (const suffix of ["#details", "?route=settings"]) {
  test(`same-document navigation publishes ${suffix} and settles loading`, async () => {
    const { wc, published } = await loadedPage();
    wc.isLoading = () => true;
    wc.emit("did-start-loading");
    wc.url += suffix;
    wc.emit("did-navigate-in-page", {}, wc.url, true, 7, 11);
    wc.isLoading = () => false;
    wc.emit("did-stop-loading");
    assert.equal(published.at(-1).url, wc.url);
    assert.equal(published.at(-1).isLoading, false);
  });
}

test("in-page events from subframes, replaced frames, or old URLs are ignored", async () => {
  const { wc, published } = await loadedPage();
  const currentUrl = wc.url;
  wc.emit("did-navigate-in-page", {}, currentUrl, false, 7, 11);
  wc.emit("did-navigate-in-page", {}, currentUrl, true, 8, 11);
  wc.emit("did-navigate-in-page", {}, currentUrl, true, 7, 12);
  wc.emit("did-navigate-in-page", {}, currentUrl + "#old", true, 7, 11);
  assert.deepEqual(published, []);
});

test("in-page completion cannot republish an invalidated session", async () => {
  const { pane, wc, published } = await loadedPage();
  pane.invalidateNavigation();
  wc.url += "#late";
  wc.emit("did-navigate-in-page", {}, wc.url, true, 7, 11);
  wc.emit("did-stop-loading");
  assert.deepEqual(published, []);
});
