import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, WebContentsView, type View } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";
import { checkBrowserPaneLifecycle } from "./browser-pane-lifecycle";

const artifactDir = process.env.BROWSER_CAPTURE_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_CAPTURE_ARTIFACT_DIR is required");
app.setPath("userData", join(artifactDir, "profile"));
const stage = (value: string) => appendFileSync(join(artifactDir, "progress.log"), `${value}\n`);

async function probe(artifactDir: string) {
  stage("app-ready");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><style>
      body{margin:0;font:24px sans-serif;background:#eee}
      header{padding:20px;background:#222;color:white}
      main{height:6000px;background:linear-gradient(#ddd,#57a)}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
      article{padding:24px;background:white;border:1px solid #888}
      </style><header>Browser viewport resize regression</header><main><div class="grid">
      ${Array.from({ length: 12 }, (_, i) => `<article>Card ${i + 1}</article>`).join("")}
      </div></main>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const window = new BrowserWindow({ width: 1100, height: 750, show: true, alwaysOnTop: true });
  const panes: BrowserPane[] = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true, getFileRoots: async () => [], onState: () => {},
  });
  try {
    await window.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html>
      <style>body{margin:0;background:#202024;color:white;font:20px sans-serif}
      header{height:44px;padding-left:24px;display:flex;align-items:center}
      main{padding:24px}#panel{position:fixed;right:0;top:44px;bottom:0;width:44%;background:#121217}
      #toolbar{height:36px;background:#343440;padding-left:16px;display:flex;align-items:center}
      </style><header>PI browser window transition regression</header>
      <main>Conversation stays visible and clickable.</main>
      <section id=panel><div id=toolbar>Local HTML preview</div></section>`)}`);
    stage("shell-loaded");
    host.setWindow(window);
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 } });
    const resize = (width: number, height: number) => {
      host.setGuestHole("pi.browser", { x: 0, y: 0, width, height });
    };
    resize(800, 500);
    host.setChromeSession("capture-regression", "page");
    await host.navigate({ url: `http://127.0.0.1:${address.port}` }, "capture-regression");
    stage("guest-loaded");
    const wc = panes[0].getWebContents();
    assert(wc);
    window.moveTop();
    window.focus();
    wc.setBackgroundThrottling(false);
    const frame = () => wc.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await frame();
    stage("guest-frame");
    const originalSend = wc.debugger.sendCommand.bind(wc.debugger);
    let resizeDuringCapture: { width: number; height: number } | undefined;
    // Synchronize a real native bounds change with Chromium's in-flight
    // screenshot, rather than relying on a machine-speed-dependent timer.
    wc.debugger.sendCommand = (method, params, sessionId) => {
      const pending = originalSend(method, params, sessionId);
      if (method === "Page.captureScreenshot" && resizeDuringCapture) {
        const size = resizeDuringCapture;
        resizeDuringCapture = undefined;
        resize(size.width - 20, size.height - 20);
        resize(size.width, size.height);
      }
      return pending;
    };
    const results = [];
    for (let i = 0; i < 12; i++) {
      stage(`capture-${i}`);
      const expected = i % 2 ? { width: 820, height: 510 } : { width: 960, height: 620 };
      resizeDuringCapture = expected;
      const raw = i >= 6;
      if (raw) {
        await host.cdpCommand("Page.captureScreenshot", { format: "png",
          captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 6000, scale: 1 } });
      } else {
        await host.screenshot({ fullPage: true });
      }
      await frame();
      const actual: unknown = await wc.executeJavaScript("({width: innerWidth, height: innerHeight})");
      results.push({ entry: raw ? "raw-cdp" : "screenshot", expected, actual });
    }
    wc.debugger.sendCommand = originalSend;
    const presentation = (views: readonly View[]): { view: View; parents: View[] } | undefined => {
      for (const view of views) {
        if (view instanceof WebContentsView && view.webContents === wc) return { view, parents: [] };
        const child = presentation(view.children);
        if (child) return { view: child.view, parents: [view, ...child.parents] };
      }
      return undefined;
    };
    const measuredPanel = async () => {
      const rect: { x: number; y: number; width: number; height: number } =
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
          const {x,y,width,height} = document.querySelector('#panel').getBoundingClientRect();
          resolve({x:Math.round(x), y:Math.round(y), width:Math.round(width), height:Math.round(height)});
        }))`);
      host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: rect });
      const hole = { x: 0, y: 36, width: rect.width, height: rect.height - 36 };
      host.setGuestHole("pi.browser", hole);
      return { x: rect.x, y: rect.y + hole.y, width: hole.width, height: hole.height };
    };
    await measuredPanel();
    await frame();
    const transitions = [];
    const nativeScreenshots: string[] = [];
    const nativeScreenshot = async (name: string) => {
      // OS-wide capture enumerates unrelated desktop windows and can block on
      // unavailable WGC sources. Keep visual collection explicit; native guest
      // placement and viewport assertions always run.
      if (process.env.BROWSER_CAPTURE_NATIVE_SCREENSHOTS !== "1") return;
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 2600, height: 1500 } });
      const source = sources.find((source) => source.id === window.getMediaSourceId());
      assert(source, "test window native capture source");
      assert(!source.thumbnail.isEmpty(), "native window capture is empty");
      writeFileSync(join(artifactDir, name), source.thumbnail.toPNG());
      nativeScreenshots.push(name);
    };
    for (const mode of ["maximize", "restore", "fullscreen", "leave-fullscreen"] as const) {
      stage(mode);
      const before: { width: number; height: number } = await wc.executeJavaScript(
        "({width: innerWidth, height: innerHeight})",
      );
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      wc.debugger.sendCommand = (method, params, sessionId) => {
        const response = originalSend(method, params, sessionId);
        if (method !== "Page.captureScreenshot") return response;
        entered();
        return Promise.all([response, gate]).then(([result]) => result);
      };
      const capture = host.screenshot({ fullPage: true });
      await started;
      try {
        const event = mode === "maximize" ? "maximize" : mode === "restore" ? "unmaximize"
          : mode === "fullscreen" ? "enter-full-screen" : "leave-full-screen";
        const changed = once(window, event);
        if (mode === "maximize") window.maximize();
        else if (mode === "restore") window.unmaximize();
        else window.setFullScreen(mode === "fullscreen");
        await changed;
        const expected = await measuredPanel();
        const surface = presentation(window.contentView.children);
        assert(surface, "browser guest must remain attached");
        let actual = surface.view.getBounds();
        for (const parent of [...surface.parents].reverse()) {
          const bounds = parent.getBounds();
          actual = { x: bounds.x + actual.x, y: bounds.y + actual.y,
            width: Math.min(actual.width, bounds.width - actual.x),
            height: Math.min(actual.height, bounds.height - actual.y) };
        }
        const viewport: unknown = await wc.executeJavaScript(
          "({width: innerWidth, height: innerHeight})",
        );
        await nativeScreenshot(`native-${mode}-during.png`);
        // During expansion the old captured viewport can be smaller than the
        // new panel, but it must be in the right place and never exceed it.
        assert.equal(actual.x, expected.x, `${mode}: guest x during capture`);
        assert.equal(actual.y, expected.y, `${mode}: guest y during capture`);
        assert(actual.width <= expected.width && actual.height <= expected.height, `${mode}: clip to panel`);
        assert.deepEqual(viewport, before, `${mode}: preserve capture viewport`);
        transitions.push({ mode, expected, during: actual, viewport });
      } finally {
        release();
        await capture;
        wc.debugger.sendCommand = originalSend;
      }
      await frame();
      const expected = await measuredPanel();
      // Native bounds updates reach the guest renderer asynchronously. Wait
      // after the final measured layout has been applied, not before it.
      await frame();
      const restored: unknown = await wc.executeJavaScript(
        "({width: innerWidth, height: innerHeight})",
      );
      assert.deepEqual(restored, { width: expected.width, height: expected.height }, `${mode}: final viewport`);
      await nativeScreenshot(`native-${mode}-after.png`);
    }
    const image = await wc.capturePage();
    assert(!image.isEmpty(), "native guest screenshot is empty");
    writeFileSync(join(artifactDir, "browser-viewport.png"), image.toPNG());
    const lifecycle = await checkBrowserPaneLifecycle(host, panes, window, `http://127.0.0.1:${address.port}`, stage);
    const report = { electron: process.versions.electron, chrome: process.versions.chrome, results, transitions, lifecycle, nativeScreenshots };
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2));
    for (const row of results) assert.deepEqual(row.actual, row.expected, row.entry);
    console.log(`BROWSER_CAPTURE_RESIZE ${JSON.stringify({ ok: true, ...report })}`);
  } finally {
    host.dispose();
    if (!window.isDestroyed()) window.destroy();
    server.close();
  }
}

app.whenReady().then(() => probe(artifactDir)).then(
  () => app.exit(0),
  (error: unknown) => { stage(String(error)); console.error(error); app.exit(1); },
);
