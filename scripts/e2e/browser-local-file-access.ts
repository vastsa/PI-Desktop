import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const artifactDir = process.env.BROWSER_LOCAL_FILE_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_LOCAL_FILE_ARTIFACT_DIR is required");
const artifactRoot = artifactDir;
app.setPath("userData", join(artifactRoot, "profile"));

async function run(): Promise<void> {
  const workspace = mkdtempSync(join(artifactRoot, "workspace-"));
  const outside = mkdtempSync(join(artifactRoot, "outside-"));
  const outsideStart = join(outside, "start.html");
  const outsideNext = join(outside, "next.html");
  const outsideMissing = join(outside, "missing.html");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(outsideNext, "<!doctype html><title>Outside next</title><p>Outside sibling</p>");
  const outsideNextUrl = pathToFileURL(realpathSync(outsideNext)).href;
  writeFileSync(outsideStart, `<!doctype html><title>Outside start</title>
    <a id="next" href="${outsideNextUrl}">Next local file</a>`);
  const outsideStartUrl = pathToFileURL(realpathSync(outsideStart)).href;

  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>HTTP page</title><p>HTTP fixture</p>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const httpUrl = `http://127.0.0.1:${address.port}/`;
  const window = new BrowserWindow({ width: 800, height: 600, show: false });
  const pane = new BrowserPane(() => {});

  try {
    pane.setWindow(window);
    pane.setBounds({ x: 0, y: 0, width: 700, height: 500 });
    pane.setVisible(true);

    const fileUrlState = await pane.navigateAndWait(outsideStartUrl, workspace, 5_000);
    assert.equal(fileUrlState?.url, outsideStartUrl, "file URL outside the workspace loads");
    const wc = pane.getWebContents();
    assert(wc, "browser guest exists after file navigation");
    assert.equal(await wc.executeJavaScript("document.title"), "Outside start");

    const absoluteState = await pane.navigateAndWait(outsideNext, workspace, 5_000);
    assert.equal(absoluteState?.url, outsideNextUrl, "absolute path outside the workspace loads");
    assert.equal(await wc.executeJavaScript("document.title"), "Outside next");

    await pane.navigateAndWait(outsideStart, workspace, 5_000);
    const localWillNavigate = once(wc, "will-navigate").then(([event, url]) => ({
      prevented: event.defaultPrevented,
      url: url as string,
    }));
    const localLinkNavigation = once(wc, "did-navigate").then(([event, url]) => url as string);
    const localPageLoaded = once(wc, "did-finish-load");
    await wc.executeJavaScript("document.querySelector('#next').click()").catch(() => undefined);
    const localAttempt = await localWillNavigate;
    assert.equal(localAttempt.prevented, false, "local pages may navigate outside the workspace");
    assert.equal(await localLinkNavigation, outsideNextUrl, "a local page follows an outside file link");
    await localPageLoaded;
    assert.equal(await wc.executeJavaScript("document.title"), "Outside next");

    await pane.navigateAndWait(httpUrl, workspace, 5_000);
    assert.equal(wc.getURL(), httpUrl, "HTTP fixture loads");

    const missingState = await pane.navigateAndWait(outsideMissing, workspace, 5_000);
    assert.equal(missingState, null, "missing local files are rejected");
    assert.equal(wc.getURL(), httpUrl, "missing files never reach Electron navigation");
    assert.equal(pane.getState()?.loadError, "LOCAL_FILE_NOT_ALLOWED");

    console.log(JSON.stringify({
      ok: true,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      fileUrl: true,
      absolutePath: true,
      localFileLink: true,
      httpPageLoads: true,
      missingFileBlocked: true,
    }));
  } finally {
    pane.dispose();
    if (!window.isDestroyed()) window.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (error: unknown) => { console.error(error); app.exit(1); },
);
