import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage, WebContentsView, type View } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const output = process.env.BROWSER_BACKGROUND_ARTIFACT_DIR;
if (!output) throw new Error("BROWSER_BACKGROUND_ARTIFACT_DIR is required");
app.setPath("userData", join(output, "profile"));

async function probe(output: string) {
  const server = createServer((request, response) => {
    const name = request.url === "/b" ? "B" : request.url === "/c" ? "C" : "A";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Page ${name}</title>
      <style>body{margin:0;padding:32px;box-sizing:border-box;min-height:700px;background:${name === "B" ? "rgb(177,77,47)" : "rgb(45,107,199)"};color:white;font:24px sans-serif}button,input{font:20px sans-serif;margin:8px;padding:12px}</style>
      <h1>Page ${name}</h1><label for="note">Note ${name}</label><input id="note">
      <button onclick="document.querySelector('output').textContent=String(++window.count)">Increment ${name}</button><output>0</output><script>window.count=0</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({ width: 1100, height: 750, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const panes: BrowserPane[] = [];
  const reveals: string[] = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => { const pane = new BrowserPane(onState, onOpenUrl); panes.push(pane); return pane; },
    isPluginLoaded: () => true,
    getFileRoots: async () => [],
    getScratchDir: (sessionId) => sessionId ? join(output, sessionId) : null,
    onState: () => {},
    onRevealView: (sessionId) => reveals.push(sessionId),
  });
  const visible = () => {
    const ids: number[] = [];
    const visit = (views: readonly View[]) => {
      for (const view of views) {
        if (!view.getVisible()) continue;
        if (view instanceof WebContentsView) ids.push(view.webContents.id);
        visit(view.children);
      }
    };
    visit(window.contentView.children);
    return ids;
  };
  const show = () => {
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 570, y: 80, width: 470, height: 560 } });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: 470, height: 560 });
  };
  const passed: string[] = [];
  try {
    await window.loadURL("data:text/html,<h1>Isolated browser background validation</h1>");
    host.setWindow(window);
    show();
    host.setChromeSession("A", "a");
    await host.navigate({ url: origin + "/a" }, "A");
    const a = panes.at(-1)!;
    const aId = a.getWebContents()!.id;
    const snapshot = await host.snapshot("A");
    host.setChromeSession("B", "b");
    await host.navigate({ url: origin + "/b" }, "B");
    const bId = panes.at(-1)!.getWebContents()!.id;
    assert.equal(snapshot.title, "Page A");
    const button = snapshot.tree.match(/- (e\d+) button "Increment A"/)?.[1];
    const input = snapshot.tree.match(/- (e\d+) textbox "Note A"/)?.[1];
    assert(button && input, snapshot.tree);
    await host.fill(input, "Background draft", "A");
    await host.click(button, "A");
    assert.equal(await host.evaluate("window.count", "A"), 1);
    assert.equal(await host.evaluate("window.count", "B"), 0);
    assert.equal(await host.evaluate("document.querySelector('#note').value", "A"), "Background draft");
    assert.deepEqual(visible(), [bId]);
    passed.push("hidden A snapshot, click and fill stay isolated while B remains visible");

    const shot = await host.screenshot({ fullPage: true }, "A");
    assert(shot.path?.startsWith(join(output, "A")));
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    assert(!image.isEmpty());
    const pixel = image.toBitmap();
    assert(pixel[0] > pixel[2] + 60 && pixel[0] > pixel[1] + 50,
      "background screenshot contains A's blue page, not B or a blank frame");
    assert.deepEqual(visible(), [bId]);
    passed.push("new hidden screenshot returns A's real pixels and owning scratch path without revealing it");

    host.detachPresentation();
    await window.webContents.reload();
    assert.deepEqual(visible(), []);
    assert.equal((await host.snapshot("A")).title, "Page A");
    await host.screenshot({ fullPage: true }, "A");
    assert.equal(await host.evaluate("document.querySelector('#note').value", "A"), "Background draft");
    show();
    host.setChromeSession("A", "a");
    assert.equal(a.getWebContents()!.id, aId);
    assert.deepEqual(visible(), [aId]);
    assert.equal(host.getPages("A")[0].tabId, "a");
    passed.push("renderer reload retains the native page, form data and background access");

    const created = await host.openTab({ url: origin + "/c" }, "C");
    assert(created.state);
    assert.equal((await host.snapshot("C")).title, "Page C");
    await host.screenshot({ fullPage: true }, "C");
    assert.deepEqual(visible(), [aId]);
    passed.push("first background preview is usable before any side-panel mount");
    await assert.rejects(host.snapshot("missing"), { code: "UNAVAILABLE" });
    host.closeSession("C");
    await assert.rejects(host.snapshot("C"), { code: "UNAVAILABLE" });
    assert.equal((await host.snapshot("A")).title, "Page A");
    assert.deepEqual(reveals, ["C"]);
    passed.push("unknown and closed sessions cannot fall back to another page");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, passed }, null, 2));
    console.log("BROWSER_BACKGROUND " + JSON.stringify({ ok: true, passed }));
  } finally {
    host.dispose();
    if (!window.isDestroyed()) window.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
app.whenReady().then(() => probe(output)).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
