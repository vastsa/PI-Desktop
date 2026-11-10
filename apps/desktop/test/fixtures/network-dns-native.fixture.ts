import assert from "node:assert/strict";
import { app, session } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { NetworkProxySettings } from "@pi-desktop/shared";
import { createNetworkDnsController } from "../../electron/main/network-dns";
import { applyNodeNetworkProxy } from "../../../../packages/agent-runtime/src/node-proxy";
import { startSystemProxyRelay } from "../../../../packages/agent-runtime/src/system-proxy-relay";

const targetHost = "pi-doh-target.invalid";
const resultPath = process.env.PI_DNS_NATIVE_RESULT!;
app.setPath("userData", process.env.PI_DNS_NATIVE_USER_DATA!);
app.commandLine.appendSwitch("ignore-certificate-errors-spki-list", process.env.PI_DNS_NATIVE_SPKI!);
app.disableHardwareAcceleration();
const checks: string[] = [];
const watchdog = setTimeout(() => finish(new Error("Native DNS fixture deadline exceeded")), 55_000);
let finished = false;
function finish(error?: unknown) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  writeFileSync(resultPath, JSON.stringify({ ok: !error, checks,
    error: error instanceof Error ? error.stack : error ? String(error) : undefined }));
  app.exit(error ? 1 : 0);
}

async function dohServer(address: string) {
  const queries: Array<{ name: string; type: number; method: string }> = [];
  const server = createHttpsServer({
    cert: readFileSync(process.env.PI_DNS_NATIVE_CERT!),
    key: readFileSync(process.env.PI_DNS_NATIVE_KEY!),
  }, (request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const packet = Buffer.concat(chunks);
        assert.equal(request.method, "POST");
        assert.ok(packet.length >= 17);
        const labels: string[] = [];
        let offset = 12;
        while (offset < packet.length && packet[offset] !== 0) {
          const size = packet[offset++];
          assert.ok(size <= 63 && offset + size < packet.length);
          labels.push(packet.subarray(offset, offset + size).toString("ascii"));
          offset += size;
        }
        offset++;
        assert.ok(offset + 4 <= packet.length);
        const name = labels.join(".");
        const type = packet.readUInt16BE(offset);
        queries.push({ name, type, method: request.method! });
        const answer = name === targetHost && type === 1;
        const header = Buffer.alloc(12);
        packet.copy(header, 0, 0, 2);
        header.writeUInt16BE(0x8180, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(answer ? 1 : 0, 6);
        const record = Buffer.alloc(answer ? 16 : 0);
        if (answer) {
          record.writeUInt16BE(0xc00c, 0);
          record.writeUInt16BE(1, 2);
          record.writeUInt16BE(1, 4);
          record.writeUInt32BE(30, 6);
          record.writeUInt16BE(4, 10);
          address.split(".").forEach((part, index) => record.writeUInt8(Number(part), 12 + index));
        }
        const body = Buffer.concat([header, packet.subarray(12, offset + 4), record]);
        response.writeHead(200, { "content-type": "application/dns-message", "content-length": body.length });
        response.end(body);
      } catch { response.writeHead(400); response.end(); }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, queries, url: `https://localhost:${port}/dns-query` };
}

async function run() {
  assert.ok(process.versions.electron);
  assert.ok(app.commandLine.getSwitchValue("ignore-certificate-errors-spki-list"));
  assert.equal(app.commandLine.hasSwitch("ignore-certificate-errors"), false);
  assert.equal(app.commandLine.hasSwitch("host-resolver-rules"), false);
  const first = await dohServer("127.0.0.1");
  const second = await dohServer("127.0.0.2");
  const requestedHosts: string[] = [];
  const target = createHttpServer((request, response) => {
    requestedHosts.push(request.headers.host ?? "");
    response.end("relay-ok");
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as { port: number }).port;
  let systemLookups = 0;
  const dns = createNetworkDnsController({
    platform: process.platform,
    configureHostResolver: config => app.configureHostResolver(config),
    clearHostResolverCache: () => session.defaultSession.clearHostResolverCache(),
    resolveHost: (host, options) => session.defaultSession.resolveHost(host, options),
    systemLookup: async () => { systemLookups++; return [{ address: "203.0.113.77", family: 4 }]; },
  });
  let relay: Awaited<ReturnType<typeof startSystemProxyRelay>> | undefined;
  try {
    await session.defaultSession.setProxy({ mode: "direct" });
    await dns.apply({ mode: "doh", serverUrl: first.url, allowSystemFallback: false });
    assert.deepEqual(await dns.lookupAll(targetHost), [{ address: "127.0.0.1", family: 4 }]);
    assert.ok(first.queries.some(query => query.name === targetHost && query.type === 1 && query.method === "POST"));
    assert.equal(systemLookups, 0);
    checks.push("native RFC8484 POST resolution without system lookup");
    relay = await startSystemProxyRelay(url => session.defaultSession.resolveProxy(url), { lookup: dns.lookup });
    assert.match(relay.url, /^socks5:\/\/system-auto:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
    for (const proxy of [{ mode: "system" }, { mode: "direct" }, { mode: "custom", url: relay.url }] satisfies NetworkProxySettings[]) {
      applyNodeNetworkProxy(proxy, process.env, relay.url, true);
      const response = await fetch(`http://${targetHost}:${targetPort}/${proxy.mode}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(await response.text(), "relay-ok");
      assert.equal(requestedHosts.at(-1), `${targetHost}:${targetPort}`);
      assert.equal(systemLookups, 0);
      checks.push(`${proxy.mode} provider route uses authenticated relay and preserves Host`);
    }
    await dns.apply({ mode: "doh", serverUrl: second.url, allowSystemFallback: false });
    assert.deepEqual(await dns.lookupAll(targetHost), [{ address: "127.0.0.2", family: 4 }]);
    assert.ok(second.queries.some(query => query.name === targetHost && query.type === 1));
    checks.push("resolver switch invalidates the previous native DNS cache");
    await dns.apply({ mode: "system" });
    assert.deepEqual(await dns.lookupAll(targetHost), [{ address: "203.0.113.77", family: 4 }]);
    assert.equal(systemLookups, 1);
    checks.push("disabling restores the system lookup path");
    const closed = createNetServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    await dns.apply({ mode: "doh", serverUrl: `https://localhost:${closedPort}/dns-query`, allowSystemFallback: false });
    await assert.rejects(dns.lookupAll(targetHost));
    assert.equal(systemLookups, 1);
    checks.push("strict resolver outage rejects without system fallback");
  } finally {
    dns.dispose();
    applyNodeNetworkProxy({ mode: "system" }, process.env);
    await relay?.close();
    target.closeAllConnections();
    first.server.closeAllConnections();
    second.server.closeAllConnections();
    await Promise.all([target, first.server, second.server].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}
app.whenReady().then(run).then(() => finish(), finish);
