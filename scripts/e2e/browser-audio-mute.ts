import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const output = process.env.BROWSER_AUDIO_MUTE_ARTIFACT_DIR;
if (!output) throw new Error("BROWSER_AUDIO_MUTE_ARTIFACT_DIR is required");
app.setPath("userData", join(output, "profile"));

async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function probe(output: string) {
  // Each page plays a quiet tone so Chromium reports it as audible.
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Tone ${request.url}</title>
      <script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();
      g.gain.value=0.02;o.connect(g).connect(c.destination);o.start();c.resume();</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({ width: 900, height: 700, show: true });
  const panes: BrowserPane[] = [];
  const published: Array<{ tabId?: string; audioMuted?: boolean; audible?: boolean }> = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async () => [],
    getScratchDir: (sessionId) => sessionId ? join(output, sessionId) : null,
    onState: (state) => published.push(state),
    onRevealView: () => {},
  });
  const passed: string[] = [];
  const state = (tabId: string) => host.getStateForPlugin("M", tabId);
  try {
    await window.loadURL("data:text/html,<h1>Browser audio mute validation</h1>");
    host.setWindow(window);
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 20, y: 60, width: 860, height: 600 } });
    host.setGuestHole("pi.browser", { x: 0, y: 0, width: 860, height: 600 });
    for (const tabId of ["one", "two"]) {
      host.setChromeSession("M", tabId);
      await host.navigate({ url: `${origin}/${tabId}` }, "M", tabId);
    }
    await until(() => state("one")?.audible === true && state("two")?.audible === true, "both tabs audible");
    passed.push("pages playing sound publish audible state");

    host.setChromeSession("M", "one");
    host.action("mute", "M", "one");
    assert.equal(state("one")?.audioMuted, true);
    assert.equal(state("two")?.audioMuted, false);
    assert.deepEqual(panes.map((pane) => pane.getWebContents()?.isAudioMuted()), [true, false],
      "only the chosen guest is muted in Chromium");
    assert.ok(published.some((entry) => entry.tabId === "one" && entry.audioMuted === true),
      "the toolbar receives the muted state");
    const audibleWhileMuted = state("one")?.audible;
    assert.equal(audibleWhileMuted, true, "a muted tab still reports that it is playing");
    passed.push("muting one tab leaves the sibling tab audible and unmuted");

    host.action("unmute", "M", "one");
    assert.equal(state("one")?.audioMuted, false);
    passed.push("unmuting restores the tab");

    host.action("mute", "M", "two");
    host.closeTab("M", "two");
    host.setChromeSession("M", "two");
    await host.navigate({ url: `${origin}/two-again` }, "M", "two");
    assert.equal(state("two")?.audioMuted, false, "a closed tab does not leak its mute choice");
    passed.push("closing a tab discards its mute choice");

    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, passed }, null, 2));
    console.log("BROWSER_AUDIO_MUTE " + JSON.stringify({ ok: true, passed }));
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
