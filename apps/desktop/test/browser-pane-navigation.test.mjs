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
