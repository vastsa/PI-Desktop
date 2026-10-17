import assert from "node:assert/strict";
import { once } from "node:events";
import { WebContentsView, type BrowserWindow, type View } from "electron";
import type { BrowserHost, BrowserRect } from "../../apps/desktop/electron/main/browser-host";
import type { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

/** Additional native regressions for the container introduced around each guest. */
export async function checkBrowserPaneLifecycle(
  host: BrowserHost, panes: BrowserPane[], window: BrowserWindow, url: string,
  stage: (name: string) => void,
): Promise<string[]> {
  const passed: string[] = [];
  const rect = { x: 570, y: 90, width: 420, height: 490 };
  const show = (bounds: BrowserRect = rect) => {
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  const attached = () => {
    const result: number[] = [];
    const visit = (views: readonly View[]) => {
      for (const view of views) {
        if (!view.getVisible()) continue;
        if (view instanceof WebContentsView) result.push(view.webContents.id);
        visit(view.children);
      }
    };
    visit(window.contentView.children);
    return result;
  };
  const viewport = (pane: BrowserPane) => {
    const wc = pane.getWebContents();
    assert(wc);
    return wc.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({width:innerWidth,height:innerHeight}))))",
    );
  };
  const hold = async (pane: BrowserPane, raw = false) => {
    const wc = pane.getWebContents();
    assert(wc);
    const original = wc.debugger.sendCommand.bind(wc.debugger);
    let release!: () => void;
    let fail!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    let count = 0;
    wc.debugger.sendCommand = (method, params, sessionId) => {
      const response = original(method, params, sessionId);
      if (method !== "Page.captureScreenshot") return response;
      count++;
      // Hold delivery of a real completed Chromium capture. Detaching before
      // Chromium has produced its frame would test platform capture liveness
      // rather than the pane's pending-completion lifecycle.
      return response.then(async result => { entered(); await gate; return result; });
    };
    const result = (raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot({ fullPage: true })
    ).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await started;
    return { release, fail, result, count: () => count, restore: () => { wc.debugger.sendCommand = original; } };
  };

  stage("lifecycle-queue");
  show();
  host.setChromeSession("lifecycle", "first");
  await host.navigate({ url }, "lifecycle");
  const first = panes.at(-1)!;
  const firstWc = first.getWebContents();
  assert(firstWc);
  const initial = await viewport(first);
  const capture = await hold(first);
  try {
    const queued = host.cdpCommand("Page.captureScreenshot", { format: "png" });
    host.setChromeSession("lifecycle", "second");
    await host.navigate({ url: url + "/second" }, "lifecycle");
    const second = panes.at(-1)!;
    assert.deepEqual(attached(), [second.getWebContents()!.id]);
    await host.screenshot();
    assert.equal(capture.count(), 1, "other pages do not start a queued capture");
    host.setChromeSession("another-session", "third");
    await host.navigate({ url: url + "/third" }, "another-session");
    assert.deepEqual(attached(), [panes.at(-1)!.getWebContents()!.id]);
    host.setChromeSession("lifecycle", "first");
    show({ x: 680, y: 110, width: 300, height: 360 });
    assert.deepEqual(attached(), [firstWc.id]);
    assert.deepEqual(await viewport(first), initial);
    capture.release();
    assert.equal((await capture.result).error, undefined);
    await queued;
    assert.equal(capture.count(), 2);
    assert.deepEqual(await viewport(first), { width: 300, height: 360 });
    passed.push("native queued captures, independent sibling/session pages and restored bounds");
  } finally { capture.release(); await capture.result; capture.restore(); }

  stage("lifecycle-hidden");
  const hidden = await hold(first, true);
  try {
    host.setChromeSurface(null);
    assert.deepEqual(attached(), [], "blocking overlays hide the presentation and guest");
    hidden.release();
    assert.equal((await hidden.result).error, undefined);
    assert.deepEqual(attached(), [], "capture completion must not expose a hidden page");
    show();
    assert.deepEqual(attached(), [firstWc.id]);
    assert.deepEqual(await viewport(first), { width: rect.width, height: rect.height });
    passed.push("native overlay hide, hidden completion and reshow");
  } finally { hidden.release(); await hidden.result; hidden.restore(); }

  stage("lifecycle-failure");
  const failed = await hold(first);
  try {
    show({ ...rect, x: 510, width: 480 });
    const failure = new Error("controlled screenshot failure");
    failed.fail(failure);
    assert.equal((await failed.result).error, failure);
    assert.deepEqual(await viewport(first), { width: 480, height: rect.height });
  } finally { failed.release(); await failed.result; failed.restore(); }
  await host.screenshot();
  passed.push("native failed capture restores bounds and next capture works");

  stage("lifecycle-close-tab");
  const closing = await hold(first);
  try {
    const rejected = assert.rejects(host.screenshot(), /browser guest is not available/);
    const destroyed = once(firstWc, "destroyed");
    host.closeTab("lifecycle", "first");
    await destroyed;
    assert(firstWc.isDestroyed());
    assert.deepEqual(attached(), []);
    host.setChromeSession("lifecycle", "replacement");
    await host.navigate({ url: url + "/replacement" }, "lifecycle");
    closing.release();
    await closing.result;
    await rejected;
    assert.equal(closing.count(), 1);
    await host.screenshot();
    passed.push("native tab close destroys guest, cancels queued capture and leaves replacement usable");
  } finally { closing.release(); await closing.result; }

  stage("lifecycle-recreate");
  const live = panes.at(-1)!;
  const liveWc = live.getWebContents();
  assert(liveWc);
  const closed = once(liveWc, "destroyed");
  liveWc.close();
  await closed;
  host.setChromeSession("lifecycle", "replacement");
  await host.navigate({ url: url + "/recreated" }, "lifecycle");
  assert.notEqual(live.getWebContents()!.id, liveWc.id);
  assert.deepEqual(attached(), [live.getWebContents()!.id]);
  assert.equal(window.contentView.children.length, 1, "destroyed guest must not leave an orphan container");
  await host.screenshot();
  passed.push("native destroyed guest can be recreated without an orphan container");

  stage("lifecycle-close-window");
  const closingWindow = await hold(live);
  try {
    window.destroy();
    host.setWindow(null);
    closingWindow.release();
    await closingWindow.result;
    assert(live.getWebContents() === null);
    host.dispose();
    passed.push("native window close during capture disposes safely and repeatedly");
  } finally { closingWindow.release(); await closingWindow.result; }
  return passed;
}
