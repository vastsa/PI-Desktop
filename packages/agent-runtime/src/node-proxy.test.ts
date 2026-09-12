import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applyNodeNetworkProxy, proxyBypassMatcher } from "./node-proxy.js";

type TestServer = Server | HttpServer;

async function listen(server: TestServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return address.port;
}

async function close(server: TestServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createSocks5Proxy(): Server {
  return createServer((client) => {
    client.once("data", (hello) => {
      if (hello[0] !== 0x05) {
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      client.once("data", (request) => {
        if (request[0] !== 0x05 || request[1] !== 0x01) {
          client.destroy();
          return;
        }
        let offset = 4;
        let host: string;
        if (request[3] === 0x01) {
          host = [...request.subarray(offset, offset + 4)].join(".");
          offset += 4;
        } else if (request[3] === 0x03) {
          const length = request[offset++];
          host = request.subarray(offset, offset + length).toString();
          offset += length;
        } else {
          client.destroy();
          return;
        }
        const port = request.readUInt16BE(offset);
        const upstream = connect(port, host);
        const closeBoth = () => {
          client.destroy();
          upstream.destroy();
        };
        client.once("error", closeBoth);
        upstream.once("error", closeBoth);
        upstream.once("connect", () => {
          // Send the full bind reply in one chunk. A real proxy is allowed to
          // coalesce these bytes, which exposed the old unshift/read race.
          client.write(
            Buffer.from([0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00]),
          );
          upstream.pipe(client);
          client.pipe(upstream);
        });
      });
    });
  });
}

describe("Node network proxy", () => {
  afterEach(() => {
    applyNodeNetworkProxy({ mode: "direct" });
  });

  it("forwards provider-style requests through SOCKS5 bind replies", async () => {
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("model response");
    });
    const proxy = createSocks5Proxy();
    let proxiedConnections = 0;
    proxy.on("connection", () => {
      proxiedConnections += 1;
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);

    try {
      applyNodeNetworkProxy({
        mode: "custom",
        url: `socks5://127.0.0.1:${proxyPort}`,
        // The default list bypasses loopback; pin one that does not so the
        // request has to go through the proxy.
        bypass: "nothing.invalid",
      });
      const response = await fetch(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        signal: AbortSignal.timeout(3_000),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("model response");
      expect(proxiedConnections).toBe(1);
    } finally {
      await close(proxy);
      await close(target);
    }
  });

  it("routes loopback origins around the proxy by default", async () => {
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("direct");
    });
    // A proxy that drops every connection: anything routed through it fails.
    const proxy = createServer((socket) => socket.destroy());
    let proxiedConnections = 0;
    proxy.on("connection", () => {
      proxiedConnections += 1;
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);

    try {
      applyNodeNetworkProxy({
        mode: "custom",
        url: `http://127.0.0.1:${proxyPort}`,
      });
      const response = await fetch(`http://127.0.0.1:${targetPort}/v1/models`, {
        signal: AbortSignal.timeout(3_000),
      });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("direct");
      expect(proxiedConnections).toBe(0);

      applyNodeNetworkProxy({
        mode: "custom",
        url: `http://127.0.0.1:${proxyPort}`,
        bypass: "example.invalid",
      });
      await expect(
        fetch(`http://127.0.0.1:${targetPort}/v1/models`, {
          signal: AbortSignal.timeout(3_000),
        }),
      ).rejects.toThrow();
      expect(proxiedConnections).toBeGreaterThan(0);
    } finally {
      await close(proxy);
      await close(target);
    }
  });
});

describe("proxyBypassMatcher", () => {
  it("matches suffix rules in every Chromium and NO_PROXY spelling", () => {
    for (const rule of [".example.com", "*.example.com", "example.com"]) {
      const matches = proxyBypassMatcher(rule);
      expect(matches("api.example.com", 443), rule).toBe(true);
      expect(matches("a.b.example.com", 443), rule).toBe(true);
      expect(matches("example.com", 443), rule).toBe(true);
      expect(matches("notexample.com", 443), rule).toBe(false);
      expect(matches("example.com.evil.net", 443), rule).toBe(false);
    }
    const glob = proxyBypassMatcher("*example.com");
    expect(glob("notexample.com", 443)).toBe(true);
    expect(glob("example.com", 443)).toBe(true);
    expect(glob("example.org", 443)).toBe(false);
  });

  it("honours host:port, IP literals, CIDR blocks and <local>", () => {
    const matches = proxyBypassMatcher(
      "localhost,127.0.0.1,::1,<local>,intranet.corp:8080,[fd00::1]:9000,10.0.0.0/8",
    );
    expect(matches("localhost", 80)).toBe(true);
    expect(matches("LOCALHOST.", 443)).toBe(true);
    expect(matches("127.0.0.1", 11434)).toBe(true);
    expect(matches("[::1]", 443)).toBe(true);
    expect(matches("printer", 9100)).toBe(true);
    expect(matches("intranet.corp", 8080)).toBe(true);
    expect(matches("intranet.corp", 443)).toBe(false);
    expect(matches("fd00::1", 9000)).toBe(true);
    expect(matches("fd00::1", 9001)).toBe(false);
    expect(matches("10.20.30.40", 443)).toBe(true);
    expect(matches("11.0.0.1", 443)).toBe(false);
    expect(matches("api.openai.com", 443)).toBe(false);
  });

  it("ignores blank entries and never matches an empty host", () => {
    const matches = proxyBypassMatcher(" , ,localhost, ");
    expect(matches("localhost", 80)).toBe(true);
    expect(matches("", 80)).toBe(false);
    expect(proxyBypassMatcher("")("localhost", 80)).toBe(false);
  });
});
