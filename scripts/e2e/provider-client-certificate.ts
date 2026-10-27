import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { app, net, session } from "electron";
import { applyNetworkProxy, disposeSystemProxyRelay } from "../../apps/desktop/electron/main/network-proxy";
import { probeModelList, probeProviderEndpoint } from "../../apps/desktop/electron/main/model-discovery";

app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("ozone-platform", "headless");
app.disableHardwareAcceleration();
const fixture = process.argv[3];
const cert = readFileSync(join(fixture, "localhost-cert.pem"), "utf8");
const key = readFileSync(join(fixture, "localhost-key.pem"), "utf8");
const fingerprint = new X509Certificate(cert).fingerprint256;
const sockets = new Set<Socket>();
let requests = 0;
let mode: "models" | "redirect" | "stall" = "models";
let requestStarted: (() => void) | undefined;
const server = createHttpsServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
  requests++;
  assert.deepEqual((req.socket as TLSSocket).getPeerCertificate(), {});
  if (mode === "redirect") {
    res.writeHead(302, { location: "https://other.example/v1/models" });
    res.end();
    return;
  }
  if (mode === "stall") { requestStarted?.(); return; }
  res.writeHead(req.headers.authorization === "Bearer fixture" ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
});
const proxy = createHttpServer();
let tunnels = 0;
proxy.on("connect", (req, client, head) => {
  assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("fixture:password").toString("base64")}`);
  const target = new URL(`http://${req.url}`);
  assert.equal(target.hostname, "localhost");
  tunnels++;
  const upstream = connect({ host: "127.0.0.1", port: Number(target.port) });
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});
for (const listener of [server, proxy]) listener.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

void app.whenReady().then(async () => {
  try {
    // Trust only this local fixture, only in this isolated Electron session.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const matches = request.hostname === "localhost" &&
        new X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      callback(matches ? 0 : -3);
    });
    setDefaultCACertificates([...getCACertificates("default"), cert]);
    server.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(server, "listening"), once(proxy, "listening")]);
    const address = server.address();
    const proxyAddress = proxy.address();
    assert.ok(address && typeof address !== "string" && proxyAddress && typeof proxyAddress !== "string");
    const baseUrl = `https://localhost:${address.port}/v1`;
    await applyNetworkProxy({ mode: "direct" });
    let baselineTimer: ReturnType<typeof setTimeout> | undefined;
    const baselineTimeout = new Promise<{ kind: "timeout" }>((resolve) => {
      baselineTimer = setTimeout(() => resolve({ kind: "timeout" }), 8_000);
    });
    const baselineOutcome = await Promise.race([
      net.fetch(`${baseUrl}/models`).then(
        () => ({ kind: "response" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      baselineTimeout,
    ]);
    if (baselineTimer !== undefined) clearTimeout(baselineTimer);
    if (baselineOutcome.kind === "response") {
      assert.fail("client certificate was unexpectedly omitted and the request succeeded");
    }
    if (baselineOutcome.kind === "error") {
      assert.ok(
        baselineOutcome.error instanceof Error &&
          baselineOutcome.error.message.includes("ERR_SSL_CLIENT_AUTH_CERT_NEEDED"),
        `unexpected baseline error: ${String(baselineOutcome.error)}`,
      );
    }
    assert.equal(requests, 0, "the original Electron 43 failure precedes HTTP");
    console.log(`baseline: Electron 43 net.fetch ${baselineOutcome.kind === "timeout" ? "stalled" : "failed"} before HTTP`);
    // Linux Electron may leave a second client-certificate handshake pending.
    // Reuse the observed failure so subsequent calls exercise the real metadata
    // fallback without issuing another Chromium request to the fixture.
    const primaryFailure = baselineOutcome.kind === "error"
      ? baselineOutcome.error
      : new Error("net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED");
    const fixtureOrigin = new URL(baseUrl).origin;
    const electronFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (new URL(requestUrl).origin === fixtureOrigin) throw primaryFailure;
      return electronFetch(input, init);
    };
    const options = { baseUrl, apiKey: "fixture", signal: AbortSignal.timeout(8_000) };
    assert.deepEqual((await probeModelList(options)).models, [{ modelId: "fixture-model", displayName: "fixture-model" }]);
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    await assert.rejects(probeModelList({ ...options, apiKey: "wrong" }), { status: 401 });
    await applyNetworkProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}`, bypass: "<-loopback>" });
    const before = tunnels;
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    assert.ok(tunnels > before, "the retry must use the configured authenticated proxy");
    await applyNetworkProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}` });
    const beforeBypass = tunnels;
    assert.equal((await probeProviderEndpoint(options)).status, 200);
    assert.equal(tunnels, beforeBypass, "localhost bypass must apply to both transports");
    await applyNetworkProxy({ mode: "direct" });
    mode = "redirect";
    await assert.rejects(probeModelList(options), /left the configured origin/);
    mode = "stall";
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const pending = probeModelList({ ...options, signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    console.log("provider client certificate E2E passed");
    await disposeSystemProxyRelay();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
