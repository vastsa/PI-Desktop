import { createServer, type Server } from "node:http";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applyNodeNetworkProxy, activeNodeTransportRoute } from "./node-proxy.js";
import { startSystemProxyRelay } from "./system-proxy-relay.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture has no port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function fixtureLookup(expected: string, seen: string[]): LookupFunction {
  return (host, options, callback) => {
    seen.push(host);
    if (host !== expected) {
      callback(Object.assign(new Error("unexpected DNS lookup"), { code: "ENOTFOUND" }), "", 4);
    } else if (options.all) {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      callback(null, "127.0.0.1", 4);
    }
  };
}

describe("desktop DNS on the authenticated relay", () => {
  afterEach(() => applyNodeNetworkProxy({ mode: "direct" }));

  it("uses the desktop lookup for a DIRECT connection, preserving the HTTP hostname", async () => {
    const seen: string[] = [];
    const target = createServer((request, response) => response.end(request.headers.host));
    const port = await listen(target);
    const host = "provider.doh.invalid";
    const relay = await startSystemProxyRelay(async () => "DIRECT", { lookup: fixtureLookup(host, seen) });
    try {
      applyNodeNetworkProxy({ mode: "system" }, process.env, relay.url);
      const response = await fetch(`http://${host}:${port}/model`, { signal: AbortSignal.timeout(3000) });
      expect(await response.text()).toBe(`${host}:${port}`);
      expect(seen).toEqual([host]);
    } finally {
      await relay.close();
      await close(target);
    }
  });

  it("resolves only the proxy endpoint and leaves the destination hostname with the proxy", async () => {
    const seen: string[] = [];
    const proxy = createServer((request, response) => response.end(request.url));
    const port = await listen(proxy);
    const proxyHost = "proxy.doh.invalid";
    const relay = await startSystemProxyRelay(async () => `PROXY ${proxyHost}:${port}`, { lookup: fixtureLookup(proxyHost, seen) });
    try {
      applyNodeNetworkProxy({ mode: "system" }, process.env, relay.url);
      const response = await fetch("http://remote-dns.invalid/model", { signal: AbortSignal.timeout(3000) });
      expect(await response.text()).toBe("http://remote-dns.invalid:80/model");
      expect(seen).toEqual([proxyHost]);
    } finally {
      await relay.close();
      await close(proxy);
    }
  });

  it("routes Direct mode through the relay only when desktop secure DNS requests it", async () => {
    const seen: string[] = [];
    const target = createServer((_request, response) => response.end("native DoH path"));
    const port = await listen(target);
    const host = "direct.doh.invalid";
    const relay = await startSystemProxyRelay(async () => "DIRECT", { lookup: fixtureLookup(host, seen) });
    try {
      applyNodeNetworkProxy({ mode: "direct" }, process.env, relay.url, true);
      expect(activeNodeTransportRoute()).toBe("direct");
      const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
      expect(await response.text()).toBe("native DoH path");
      expect(seen).toEqual([host]);
    } finally {
      await relay.close();
      await close(target);
    }
  });

  it("fails closed instead of silently using system DNS when the required relay is absent", () => {
    expect(() => applyNodeNetworkProxy({ mode: "direct" }, {}, undefined, true)).toThrow(/relay/i);
  });
});
