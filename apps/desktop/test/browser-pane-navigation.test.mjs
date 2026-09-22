import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Electron is the external boundary; all navigation and timeout logic below
// runs in the production BrowserPane, without opening a native window.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class WebContentsView {
    static instances = [];
    constructor() {
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
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      WebContentsView.instances.push(this);
    }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView } = await import("electron");
const settled = () => new Promise(setImmediate);

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pane = new BrowserPane(() => {});
  // The production class creates its native guest lazily at the first request.
  const request = pane.navigateAndWait("https://fixture.invalid/new", null, 100);
  const wc = WebContentsView.instances.at(-1).webContents;
  return { pane, wc, request };
}

test("timing out a new preview does not return the previous document as ready", async (t) => {
  const { request } = harness(t);
  t.mock.timers.tick(100);
  assert.equal(await request, null);
});

test("a rejected navigation does not return the previous document as ready", async (t) => {
  const { pane, wc, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  wc.loadURL = async () => { throw new Error("fixture load failure"); };
  assert.equal(await pane.navigateAndWait("https://fixture.invalid/failed"), null);
});

test("a completed navigation returns its actual page, including redirects", async (t) => {
  const { pane, wc, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  wc.loadURL = async () => { wc.url = "https://fixture.invalid/redirected"; };
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
