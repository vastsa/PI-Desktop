import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function fixture(t, services = {}, permissions = ["net.fetch"], main = "module.exports = {};") {
  const dir = mkdtempSync(join(tmpdir(), "pi-fetch-redirect-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "test.redirect", name: "Redirect", version: "0.1.0",
    main: "main.js", permissions, net: { domains: ["127.0.0.1"] },
  }));
  writeFileSync(join(dir, "main.js"), main);
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry, audit: (entry) => audits.push(entry), ...services,
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload("test.redirect");
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.loadFromPath(dir);
  return { runtime, audits, call: (input) => runtime.invokePanelBridge("test.redirect", "net.fetch", input) };
}

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

for (const backend of ["default", "injected"]) {
  test(`${backend}: redirect modes never request the target unless following`, async (t) => {
    let targetHits = 0;
    const target = await server(t, (_req, res) => { targetHits++; res.end("target"); });
    const origin = await server(t, (req, res) => {
      res.writeHead(Number(req.url.slice(1)), { location: `${target}/end`, "x-fixture": "redirect" });
      res.end("original");
    });
    const services = backend === "injected" ? { fetch: (url, init) => {
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal);
      return fetch(url, init);
    } } : {};
    const { call, audits } = await fixture(t, services);
    for (const status of [301, 302, 303, 307, 308]) {
      await assert.rejects(call({ url: `${origin}/${status}`, redirect: "error" }), { code: "REDIRECT_DISALLOWED" });
      assert.equal(targetHits, 0);
      const manual = await call({ url: `${origin}/${status}`, redirect: "manual" });
      assert.equal(manual.status, status);
      assert.equal(manual.headers.location, `${target}/end`);
      assert.equal(manual.bodyText, "original");
      assert.equal(targetHits, 0);
    }
    assert.equal((await call({ url: `${origin}/302` })).bodyText, "target");
    assert.equal((await call({ url: `${origin}/307`, redirect: "follow" })).status, 200);
    assert.equal(targetHits, 2);
    assert.ok(audits.some((entry) => entry.api === "net.fetch" && entry.status === 302));
  });
}

test("invalid policies and missing permissions fail before any request", async (t) => {
  let hits = 0;
  const url = await server(t, (_req, res) => { hits++; res.end(); });
  const { call } = await fixture(t);
  for (const redirect of ["same-origin", "", null, false, 1, {}]) {
    await assert.rejects(call({ url, redirect }), { code: "INVALID_ARGUMENT" });
  }
  const denied = await fixture(t, {}, []);
  await assert.rejects(denied.call({ url, redirect: "manual" }), { code: "PERMISSION_DENIED" });
  assert.equal(hits, 0);
});

test("relative redirects, missing Location and loops have bounded behavior", async (t) => {
  let hits = 0;
  const origin = await server(t, (req, res) => {
    hits++;
    if (req.url === "/relative") res.writeHead(302, { location: "done" }).end();
    else if (req.url === "/missing") res.writeHead(302).end("missing");
    else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
    else res.end("done");
  });
  const { call } = await fixture(t);
  assert.equal((await call({ url: `${origin}/relative` })).bodyText, "done");
  assert.equal((await call({ url: `${origin}/missing` })).status, 302);
  await assert.rejects(call({ url: `${origin}/missing`, redirect: "error" }), { code: "REDIRECT_DISALLOWED" });
  hits = 0;
  await assert.rejects(call({ url: `${origin}/loop` }), { code: "UNAVAILABLE" });
  assert.equal(hits, 6);
});

test("allowlist is checked on every injected transport hop", async (t) => {
  let hits = 0;
  const { call } = await fixture(t, { fetch: async () => {
    hits++;
    return new Response(null, { status: 302, headers: { location: "http://example.invalid/" } });
  } });
  await assert.rejects(call({ url: "http://127.0.0.1/" }), { code: "PERMISSION_DENIED" });
  assert.equal(hits, 1);
});

test("the timeout aborts a pending response", async (t) => {
  const url = await server(t, () => {});
  const { call } = await fixture(t);
  await assert.rejects(call({ url, redirect: "manual", timeoutMs: 25 }), { code: "TIMEOUT" });
});

test("capability query exposes supported policies without making a request", async (t) => {
  const { runtime } = await fixture(t);
  assert.deepEqual(await runtime.invokePanelBridge("test.redirect", "net.getCapabilities"), {
    fetchRedirectModes: ["follow", "error", "manual"],
  });
});

for (const backend of ["default", "injected"]) {
  test(`${backend}: real example plugin queries capabilities and fetches across IPC`, async (t) => {
    let hits = 0;
    const target = await server(t, (_req, res) => { hits++; res.end("target"); });
    const origin = await server(t, (_req, res) => res.writeHead(302, { location: target }).end("original"));
    const main = readFileSync(new URL("../../../examples/plugins/fetch-redirect/main.js", import.meta.url), "utf8");
    const services = backend === "injected" ? { fetch: (url, init) => fetch(url, init) } : {};
    const { runtime, audits } = await fixture(t, services, ["net.fetch"], main);
    const probe = (redirect) => runtime.invokePanelBridge("test.redirect", "probe.fetch", { url: origin, redirect });
    await assert.rejects(probe("error"), { code: "REDIRECT_DISALLOWED" });
    assert.equal(hits, 0);
    assert.equal((await probe("manual")).status, 302);
    assert.equal(hits, 0);
    assert.equal((await probe("follow")).bodyText, "target");
    assert.equal(hits, 1);
    assert.ok(audits.some((entry) => entry.errorCode === "REDIRECT_DISALLOWED" && entry.ok === false));
  });
}

test("the example refuses old hosts before sending a request", async () => {
  const main = readFileSync(new URL("../../../examples/plugins/fetch-redirect/main.js", import.meta.url), "utf8");
  let hits = 0;
  for (const capabilities of [undefined, async () => ({ fetchRedirectModes: ["follow"] })]) {
    const module = { exports: {} };
    runInNewContext(main, { module, pi: { net: {
      getCapabilities: capabilities, fetch: async () => { hits++; },
    } } });
    await assert.rejects(module.exports.onPanelInvoke("probe.fetch", {
      url: "http://127.0.0.1/", redirect: "error",
    }), { code: "UNSUPPORTED" });
  }
  assert.equal(hits, 0);
});

test("net.anyHost does not override a no-follow policy", async (t) => {
  let hits = 0;
  const url = await server(t, (_req, res) => {
    hits++;
    res.writeHead(302, { location: "/next" }).end("original");
  });
  const { call } = await fixture(t, {}, ["net.fetch", "net.anyHost"]);
  await assert.rejects(call({ url, redirect: "error" }), { code: "REDIRECT_DISALLOWED" });
  assert.equal(hits, 1);
  assert.equal((await call({ url, redirect: "manual" })).bodyText, "original");
  assert.equal(hits, 2);
});
