import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { register } from "node:module";
import { connect as tcpConnect } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { gzipSync } from "node:zlib";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { fetchHttpsMetadata } = await import("../electron/main/provider-https-metadata.ts");
const fixtures = new URL("../../../scripts/e2e/fixtures/certificates/", import.meta.url);
const cert = await readFile(new URL("localhost-cert.pem", fixtures), "utf8");
const key = await readFile(new URL("localhost-key.pem", fixtures), "utf8");

async function fixture(t, { required = false, handler } = {}) {
  const sockets = new Set();
  const received = [];
  const server = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: required }, (req, res) => {
    received.push({ url: req.url, method: req.method, auth: req.headers.authorization, certificate: req.socket.getPeerCertificate() });
    if (handler) return handler(req, res);
    res.writeHead(req.headers.authorization === "Bearer fixture" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, received, url: `https://localhost:${server.address().port}/v1/models` };
}

const init = (signal = new AbortController().signal) => ({ headers: { Authorization: "Bearer fixture" }, redirect: "manual", signal });
async function connect(_host, port) {
  const socket = tcpConnect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}
function trustFixture(t) {
  const defaults = getCACertificates("default");
  setDefaultCACertificates([...defaults, cert]);
  t.after(() => setDefaultCACertificates(defaults));
}

test("optional client certificates permit authenticated metadata and ordinary 401 responses", async (t) => {
  trustFixture(t);
  const { url, received } = await fixture(t);
  const response = await fetchHttpsMetadata(url, init(), connect);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "fixture-model" }] });
  assert.deepEqual(received[0], { url: "/v1/models", method: "GET", auth: "Bearer fixture", certificate: {} });
  assert.equal((await fetchHttpsMetadata(url, { ...init(), headers: {} }, connect)).status, 401);
});

test("required client authentication still fails", async (t) => {
  trustFixture(t);
  const { url, received } = await fixture(t, { required: true });
  await assert.rejects(fetchHttpsMetadata(url, init(), connect));
  assert.equal(received.length, 0);
});

test("untrusted server certificates are rejected", async (t) => {
  const { url, received } = await fixture(t);
  await assert.rejects(fetchHttpsMetadata(url, init(), connect), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.equal(received.length, 0);
});

test("hostname validation is retained even through a supplied tunnel", async (t) => {
  trustFixture(t);
  const { url, received } = await fixture(t);
  await assert.rejects(fetchHttpsMetadata(url.replace("localhost", "127.0.0.1"), init(), connect), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.equal(received.length, 0);
});

test("redirects are returned to the existing origin guard without sending credentials onward", async (t) => {
  trustFixture(t);
  const { url, received } = await fixture(t, { handler: (_req, res) => {
    res.writeHead(302, { location: "https://other.example/v1/models" });
    res.end();
  } });
  const response = await fetchHttpsMetadata(url, init(), connect);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://other.example/v1/models");
  assert.equal(received.length, 1);
});

test("compressed metadata is decoded", async (t) => {
  trustFixture(t);
  const { url } = await fixture(t, { handler: (_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync('{"data":[]}'));
  } });
  assert.deepEqual(await (await fetchHttpsMetadata(url, init(), connect)).json(), { data: [] });
});

test("aborting while the response body is pending closes the request", async (t) => {
  trustFixture(t);
  const controller = new AbortController();
  const { url } = await fixture(t, { handler: (_req, res) => {
    res.writeHead(200);
    res.write('{"data":[');
    controller.abort();
  } });
  await assert.rejects(fetchHttpsMetadata(url, init(controller.signal), connect), { name: "AbortError" });
});

test("cancellation rejects before a late tunnel arrives and closes that tunnel", async () => {
  const controller = new AbortController();
  let deliver;
  const connected = new Promise((resolve) => { deliver = resolve; });
  const request = fetchHttpsMetadata("https://localhost/v1/models", init(controller.signal), () => connected);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  const { Socket } = await import("node:net");
  const socket = new Socket();
  deliver(socket);
  await once(socket, "close");
  assert.equal(socket.destroyed, true);
});


test("the original timeout reason survives cancellation during TLS handshake", async (t) => {
  const controller = new AbortController();
  const timeout = new DOMException("metadata budget exhausted", "TimeoutError");
  const { createServer: createTcpServer } = await import("node:net");
  const server = createTcpServer((socket) => {
    t.after(() => socket.destroy());
    controller.abort(timeout);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(fetchHttpsMetadata(`https://localhost:${port}/models`, init(controller.signal), connect), (error) => error === timeout);
});

test("OPTIONS probes keep their method and pre-aborted probes never connect", async (t) => {
  trustFixture(t);
  const { url, received } = await fixture(t);
  const response = await fetchHttpsMetadata(url, { ...init(), method: "OPTIONS" }, connect);
  assert.equal(response.status, 200);
  assert.equal(received[0].method, "OPTIONS");
  await assert.rejects(fetchHttpsMetadata(url, init(AbortSignal.abort()), () => {
    assert.fail("pre-aborted probe connected");
  }), { name: "AbortError" });
});
