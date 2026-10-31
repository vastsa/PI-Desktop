import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The CDP layer is a controllable stub; browser-host.ts itself is real.
register(new URL("./helpers/browser-cdp-stub-hook.mjs", import.meta.url).href);
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserCdp } = await import("./helpers/browser-cdp-stub.mjs");

const settled = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Manual fake clock over setTimeout: the deadline handlers arm real timers,
// so tests advance 30 seconds without waiting.
function fakeClock(t) {
  const pending = new Map();
  let now = 0;
  let seq = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    seq += 1;
    pending.set(seq, { callback, at: now + (delay ?? 0) });
    return { id: seq, ref() {}, unref() {}, hasRef: () => true };
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    pending.delete(handle?.id);
  });
  return {
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending.entries()]) {
        if (job.at <= now) {
          pending.delete(id);
          try { job.callback(); } catch { /* unrelated boot timers may fail late */ }
        }
      }
    },
  };
}

function harness() {
  const roots = [], loads = [];
  const createPane = (onState) => {
    let state = null;
    const wc = { isDestroyed: () => false };
    const pane = {
      visible: false, disposed: false,
      setWindow: () => {}, setBounds: () => {},
      setVisible(value) { this.visible = value; },
      getState: () => state,
      getWebContents: () => wc,
      webContents: wc,
      invalidateNavigation: () => {},
      captureScreenshot: (run) => run(wc),
      withStableViewport: (run) => run(wc),
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
    return pane;
  };
  const host = new BrowserHost({
    createPane, isPluginLoaded: () => true,
    getFileRoots(sessionId) {
      const done = deferred(); roots.push({ sessionId, ...done }); return done.promise;
    },
    onState: () => {},
    onRevealView: () => {},
  });
  host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 100, y: 20, width: 400, height: 600 },
  });
  host.setGuestHole("pi.browser", { x: 0, y: 30, width: 400, height: 570 });
  return { host, roots, loads };
}

async function open(h, sessionId, tabId, url) {
  h.host.setChromeSession(sessionId, tabId, url);
  h.roots.at(-1).resolve([`/projects/${sessionId}`]);
  await settled(); h.loads.at(-1).finish(); await settled();
}

test("a hung snapshot is rejected by the deadline and detaches the debugger session", async (t) => {
  const clock = fakeClock(t);
  const h = harness();
  await open(h, "A", "one", "a.html");
  const cdp = BrowserCdp.current;
  cdp.hang.add("snapshot");

  const pending = assert.rejects(h.host.snapshot(), /browser snapshot timed out/);
  clock.advance(30_000);
  await pending;
  assert.equal(cdp.detached.length, 1, "timeout recovery detaches the debugger session");
});

test("click, fill and evaluate share the same deadline", async (t) => {
  const clock = fakeClock(t);
  const h = harness();
  await open(h, "A", "one", "a.html");
  BrowserCdp.current.hang.add("click").add("fill").add("evaluate");

  const clickPending = assert.rejects(h.host.click("uid-1"), /browser click timed out/);
  const fillPending = assert.rejects(h.host.fill("uid-1", "text"), /browser fill timed out/);
  const evaluatePending = assert.rejects(h.host.evaluate("1+1"), /browser evaluate timed out/);
  clock.advance(30_000);
  await Promise.all([clickPending, fillPending, evaluatePending]);
});

test("an allow-listed cdpCommand other than screenshots is deadline-bounded too", async (t) => {
  const clock = fakeClock(t);
  const h = harness();
  await open(h, "A", "one", "a.html");
  BrowserCdp.current.hang.add("Runtime.evaluate");

  const pending = assert.rejects(
    h.host.cdpCommand("Runtime.evaluate", { expression: "1" }),
    /browser cdp Runtime\.evaluate timed out/,
  );
  clock.advance(30_000);
  await pending;
});

test("calls that finish in time are unaffected by the deadline", async (t) => {
  const clock = fakeClock(t);
  const h = harness();
  await open(h, "A", "one", "a.html");

  const snapshot = await h.host.snapshot();
  assert.equal(snapshot.tree, "fixture-tree");
  const evaluated = await h.host.evaluate("1+1");
  assert.deepEqual(evaluated, { expression: "1+1" });
  const cdp = await h.host.cdpCommand("Page.getLayoutMetrics", {});
  assert.equal(cdp.method, "Page.getLayoutMetrics");
  // Advancing well past the deadline must fire nothing: the timers were cleared.
  clock.advance(60_000);
  assert.deepEqual(BrowserCdp.current.detached, []);
});
