import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const dataDir = mkdtempSync(join(scratch, "pi-fetch-binary-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { pluginChildEnv } = await import("../electron/main/child-process-env.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
const LIMIT = 16 * 1024 * 1024;
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const MAIN = `module.exports = {
  async onPanelInvoke(channel, input) {
    if (channel === "probe.capabilities") return pi.net.getCapabilities();
    if (channel === "probe.fetch") return pi.net.fetch(input);
  },
};`;

async function fixture(t, { services = {}, permissions = ["net.fetch"], domains = ["127.0.0.1"] } = {}) {
  const dir = mkdtempSync(join(scratch, "pi-fetch-binary-plugin-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "test.binary", name: "Binary", version: "0.1.0",
    main: "main.js", permissions, net: { domains },
  }));
  writeFileSync(join(dir, "main.js"), MAIN);
  const audits = [];
  const children = [];
  const runtime = new PluginRuntime({
    hostEntry, audit: (entry) => audits.push(entry), ...services,
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { env: pluginChildEnv("test.binary"), stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload("test.binary");
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? undefined
      : new Promise((resolve) => child.once("exit", resolve))));
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.loadFromPath(dir);
  return {
    audits,
    call: (input, boundary = "panel") => runtime.invokePanelBridge("test.binary",
      boundary === "worker" ? "probe.fetch" : "net.fetch", input),
    capabilities: (boundary) => runtime.invokePanelBridge("test.binary",
      boundary === "worker" ? "probe.capabilities" : "net.getCapabilities"),
  };
}

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

for (const backend of ["default", "injected"]) {
  test(`${backend}: panel and worker preserve binary, empty and text bodies over HTTP`, async (t) => {
    const received = [];
    const url = await server(t, async (req, res) => {
      const body = await readBody(req);
      received.push({ body, method: req.method, contentType: req.headers["content-type"] });
      res.writeHead(201, { "x-fixture": "binary" }).end("uploaded");
    });
    const services = backend === "injected" ? { fetch: (target, init) => {
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal);
      return fetch(target, init);
    } } : {};
    const { call, audits } = await fixture(t, { services });
    for (const boundary of ["panel", "worker"]) {
      const result = await call({ url, method: "POST", headers: { "content-type": "application/octet-stream" },
        bodyBase64: BYTES.toString("base64") }, boundary);
      assert.equal(result.status, 201);
      assert.equal(result.headers["x-fixture"], "binary");
      assert.equal(result.bodyText, "uploaded");
      assert.deepEqual(received.at(-1), { body: BYTES, method: "POST", contentType: "application/octet-stream" });
      await call({ url, method: "POST", bodyBase64: "" }, boundary);
      assert.equal(received.at(-1).body.length, 0);
      const text = "existing text: héllo\u0000世界";
      await call({ url, method: "POST", body: text }, boundary);
      assert.deepEqual(received.at(-1).body, Buffer.from(text));
    }
    assert.equal(received.length, 6);
    assert.equal(audits.filter((entry) => entry.api === "net.fetch" && entry.status === 201).length, 6);
    assert.ok(audits.every((entry) => !JSON.stringify(entry).includes(BYTES.toString("base64"))));
  });
}

test("binary capabilities cross both boundaries without a network grant or transport call", async (t) => {
  const { capabilities } = await fixture(t, { permissions: [], services: { fetch: () => {
    assert.fail("capability query must not invoke the transport");
  } } });
  for (const boundary of ["panel", "worker"]) {
    assert.deepEqual(await capabilities(boundary), {
      fetchRedirectModes: ["follow", "error", "manual"],
      binaryRequestBody: true,
      maxBinaryBodyBytes: LIMIT,
    });
  }
});

test("invalid binary inputs are refused at both boundaries before any transport or HTTP request", async (t) => {
  let hits = 0;
  let transportCalls = 0;
  const url = await server(t, (_req, res) => { hits++; res.end(); });
  const { call } = await fixture(t, { services: { fetch: (target, init) => {
    transportCalls++;
    return fetch(target, init);
  } } });
  const invalid = [null, false, true, 7, [], {}, "payload-secret!", "AA", "AA=", "A===", "====",
    "AA==\n", " AA==", "AA-_", "AB==", "AAB=", "AA==AAAA"];
  for (const boundary of ["panel", "worker"]) {
    for (const bodyBase64 of invalid) {
      await assert.rejects(call({ url, method: "POST", bodyBase64 }, boundary), (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.ok(!error.message.includes("payload-secret"));
        return true;
      });
    }
    for (const body of ["", "text", false, 0, null]) {
      await assert.rejects(call({ url, method: "POST", body, bodyBase64: "" }, boundary), { code: "INVALID_ARGUMENT" });
    }
    for (const size of [LIMIT + 1, LIMIT + 3]) {
      await assert.rejects(call({ url, method: "POST", bodyBase64: Buffer.alloc(size).toString("base64") }, boundary),
        { code: "INVALID_ARGUMENT" });
    }
  }
  assert.equal(transportCalls, 0);
  assert.equal(hits, 0);
});

test("the exact 16 MiB decoded limit uploads through worker IPC and localhost HTTP", async (t) => {
  const expected = Buffer.alloc(LIMIT, 0x80);
  expected[0] = 0;
  expected[expected.length - 1] = 255;
  let received;
  const url = await server(t, async (req, res) => {
    received = await readBody(req);
    res.end("limit accepted");
  });
  const { call } = await fixture(t);
  assert.equal((await call({ url, method: "POST", bodyBase64: expected.toString("base64") }, "worker")).bodyText,
    "limit accepted");
  assert.equal(received.length, LIMIT);
  assert.equal(createHash("sha256").update(received).digest("hex"), createHash("sha256").update(expected).digest("hex"));
});

test("binary requests retain permission and per-hop egress gates through worker IPC", async (t) => {
  let hits = 0;
  const services = { fetch: async () => {
    hits++;
    return new Response(null, { status: 307, headers: { location: "http://example.invalid/" } });
  } };
  const input = { url: "http://127.0.0.1/", method: "POST", bodyBase64: BYTES.toString("base64") };
  const denied = await fixture(t, { services, permissions: [] });
  const noDomains = await fixture(t, { services, domains: [] });
  for (const boundary of ["panel", "worker"]) {
    await assert.rejects(denied.call(input, boundary), { code: "PERMISSION_DENIED" });
    await assert.rejects(noDomains.call(input, boundary), { code: "PERMISSION_DENIED" });
  }
  assert.equal(hits, 0);
  const allowed = await fixture(t, { services });
  await assert.rejects(allowed.call(input, "worker"), { code: "PERMISSION_DENIED" });
  assert.equal(hits, 1);
  assert.ok(allowed.audits.some((entry) => entry.api === "net.fetch" && entry.errorCode === "PERMISSION_DENIED"));
});

test("binary redirects preserve no-follow policies, net.anyHost and raw bytes when following", async (t) => {
  const targetBodies = [];
  const target = await server(t, async (req, res) => { targetBodies.push(await readBody(req)); res.end("target"); });
  const originBodies = [];
  const origin = await server(t, async (req, res) => {
    originBodies.push(await readBody(req));
    res.writeHead(307, { location: target }).end("original");
  });
  const { call, audits } = await fixture(t, { permissions: ["net.fetch", "net.anyHost"], domains: [] });
  const input = { url: origin, method: "POST", bodyBase64: BYTES.toString("base64") };
  for (const boundary of ["panel", "worker"]) {
    await assert.rejects(call({ ...input, redirect: "error" }, boundary), { code: "REDIRECT_DISALLOWED" });
    assert.equal(targetBodies.length, 0);
    assert.equal((await call({ ...input, redirect: "manual" }, boundary)).bodyText, "original");
    assert.equal(targetBodies.length, 0);
  }
  assert.equal((await call(input, "worker")).bodyText, "target");
  assert.deepEqual(targetBodies, [BYTES]);
  assert.equal(originBodies.length, 5);
  assert.ok(originBodies.every((body) => body.equals(BYTES)));
  assert.ok(audits.some((entry) => entry.api === "net.fetch" && entry.errorCode === "REDIRECT_DISALLOWED"));
});

test("binary uploads retain the host timeout and abort signal", async (t) => {
  const { call } = await fixture(t, { services: { fetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) } });
  await assert.rejects(call({ url: "http://127.0.0.1/", method: "POST", bodyBase64: BYTES.toString("base64"), timeoutMs: 1 }, "worker"),
    { code: "TIMEOUT" });
});
