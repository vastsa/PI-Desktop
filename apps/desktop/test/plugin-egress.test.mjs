import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const panelHostSrc = readFileSync(
  join(desktopRoot, "electron/main/plugin-panel-host.ts"),
  "utf8",
);
const runtimeSrc = readFileSync(
  join(desktopRoot, "electron/main/plugin-runtime.ts"),
  "utf8",
);

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function createRuntime(t) {
  const audits = [];
  const panels = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    openPanel: async (request) => panels.push(request),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, panels };
}

/** A plugin whose only job is to exist so the host API can be exercised. */
function writePlugin({ id, permissions = ["net.fetch"], net, ui, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-egress-plugin-"));
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "0.0.1",
    main: "main.js",
    permissions,
    ...(net ? { net } : {}),
    ...(ui ? { ui } : {}),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main ?? "module.exports = {};", "utf8");
  if (ui?.panel) writeFileSync(join(dir, ui.panel), "<html></html>", "utf8");
  return dir;
}

async function listenOnce(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("net.fetch is denied when the plugin declares no domains", async (t) => {
  const { runtime, audits } = createRuntime(t);
  const dir = writePlugin({ id: "egress.none" });
  await runtime.loadFromPath(dir);

  await assert.rejects(
    () => runtime.invokePanelBridge("egress.none", "net.fetch", { url: "https://evil.com/" }),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      // The permission alone must not be enough: an allowlist is required.
      assert.match(error.message, /declares no manifest\.net\.domains/);
      return true;
    },
  );
  assert.ok(
    audits.some((e) => e.api === "net.fetch" && e.errorCode === "PERMISSION_DENIED"),
    "the refused egress is audited",
  );
});

test("net.fetch is denied for a host outside the declared domains", async (t) => {
  const { runtime } = createRuntime(t);
  const dir = writePlugin({
    id: "egress.scoped",
    net: { domains: ["api.github.com"] },
  });
  await runtime.loadFromPath(dir);

  await assert.rejects(
    () =>
      runtime.invokePanelBridge("egress.scoped", "net.fetch", {
        url: "https://evil.com/collect",
      }),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.match(error.message, /host not in manifest\.net\.domains: evil\.com/);
      return true;
    },
  );
});

test("net.fetch reaches a declared host", async (t) => {
  const server = await listenOnce((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  t.after(() => server.close());

  const { runtime } = createRuntime(t);
  const dir = writePlugin({
    id: "egress.allowed",
    net: { domains: ["127.0.0.1"] },
  });
  await runtime.loadFromPath(dir);

  const result = await runtime.invokePanelBridge("egress.allowed", "net.fetch", {
    url: `http://127.0.0.1:${server.port}/ping`,
  });
  assert.equal(result.status, 200);
  assert.equal(result.bodyText, "ok");
});

test("a redirect off the allowlist cannot carry the request out", async (t) => {
  // The classic bypass: declare a benign host, then let it 302 to the collector.
  const collector = await listenOnce((_req, res) => {
    res.writeHead(200).end("collected");
  });
  t.after(() => collector.close());
  const hop = await listenOnce((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.2:${collector.port}/c` }).end();
  });
  t.after(() => hop.close());

  const { runtime } = createRuntime(t);
  const dir = writePlugin({
    id: "egress.redirect",
    net: { domains: ["127.0.0.1"] },
  });
  await runtime.loadFromPath(dir);

  await assert.rejects(
    () =>
      runtime.invokePanelBridge("egress.redirect", "net.fetch", {
        url: `http://127.0.0.1:${hop.port}/start`,
      }),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.match(error.message, /127\.0\.0\.2/);
      return true;
    },
  );
});

test("the panel session is handed the plugin's allowlist", async (t) => {
  const { runtime, panels } = createRuntime(t);
  const dir = writePlugin({
    id: "egress.panel",
    permissions: ["ui.panel"],
    net: { domains: ["api.github.com"] },
    ui: { panel: "panel.html" },
    main: `
      module.exports = {
        async onLoad() {
          await pi.ui.openPanel();
        },
      };
    `,
  });
  await runtime.loadFromPath(dir);

  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0].netDomains, ["api.github.com"]);
  assert.equal(panels[0].allowMicrophone, false);
});

test("ui.microphone grants audio-only media permission to a panel", async (t) => {
  const { runtime, panels } = createRuntime(t);
  const dir = writePlugin({
    id: "egress.mic",
    permissions: ["ui.panel", "ui.microphone"],
    ui: { panel: "panel.html" },
    main: `
      module.exports = {
        async onLoad() { await pi.ui.openPanel(); },
      };
    `,
  });
  await runtime.loadFromPath(dir);
  assert.equal(panels[0].allowMicrophone, true);
  assert.match(panelHostSrc, /mediaTypes/);
  assert.match(panelHostSrc, /type === "audio"/);
  assert.match(panelHostSrc, /details\.mediaType === "audio"/);
});

test("the panel session filters requests and refuses device permissions", () => {
  // `sandbox: true` removes Node, not the network. Without a webRequest filter
  // the panel is an exfiltration channel that never consults net.fetch.
  assert.match(panelHostSrc, /webRequest\.onBeforeRequest/);
  assert.match(panelHostSrc, /isNetUrlAllowed\(details\.url, domains\)/);
  assert.match(panelHostSrc, /cancel: true/);
  assert.match(panelHostSrc, /setPermissionRequestHandler/);
  assert.match(panelHostSrc, /setPermissionCheckHandler/);
  // window.open would otherwise mint a window outside the filtered session.
  assert.match(panelHostSrc, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
});

test("remote MCP endpoints answer to the same allowlist", () => {
  assert.match(runtimeSrc, /endpoint not in manifest\.net\.domains/);
  assert.match(
    runtimeSrc,
    /if \(server\.transport === "http"\) \{[\s\S]*?isNetUrlAllowed\(url, this\.netDomains\(loaded\)\)/,
  );
});

test("a malformed allowlist fails closed", () => {
  // validateManifest rejects it at install, so this path only runs if the
  // manifest changed underneath us -- it must mean "no egress", not "all".
  assert.match(runtimeSrc, /return parsed\.ok \? \(parsed\.domains \?\? \[\]\) : \[\]/);
});
