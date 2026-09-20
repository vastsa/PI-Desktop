import { connect, createServer, type Server } from "node:net";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseProxyUrl, type ParsedProxyUrl } from "@pi-desktop/shared";
import { startAuthenticatedProxyRelay } from "./authenticated-proxy-relay.js";
import { socks5Connect } from "./socks5.js";

type Closable = Server | HttpServer;

async function listen(server: Closable): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return address.port;
}

async function close(server: Closable): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function mustParse(url: string): ParsedProxyUrl {
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function createOriginServer(body: string): HttpServer {
  return createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
}

function createBasicHttpConnectProxy(user: string, password: string): Server {
  const expected = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return createServer((client) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      client.off("data", onData);
      const header = buf.subarray(0, headerEnd).toString("latin1");
      if (!header.includes(`Proxy-Authorization: Basic ${expected}`)) {
        client.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"p\"\r\n\r\n",
        );
        return;
      }
      const requestLine = header.split("\r\n", 1)[0] ?? "";
      const match = requestLine.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const destHost = match[1]!;
      const destPort = Number(match[2]);
      const leftover = buf.subarray(headerEnd + 4);
      const upstream = createServerConnection(destHost, destPort);
      const fail = () => {
        client.destroy();
        upstream.destroy();
      };
      client.once("error", fail);
      upstream.once("error", fail);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (leftover.length) upstream.write(leftover);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });
}

function createServerConnection(host: string, port: number) {
  return connect({ host, port });
}

function createSocks5AuthProxy(user: string, password: string): Server {
  return createServer((client) => {
    client.once("data", (hello) => {
      if (hello[0] !== 0x05) {
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x05, 0x02]));
      client.once("data", (auth) => {
        const userLen = auth[1] ?? 0;
        const gotUser = auth.subarray(2, 2 + userLen).toString("utf8");
        const passLen = auth[2 + userLen] ?? 0;
        const gotPass = auth
          .subarray(3 + userLen, 3 + userLen + passLen)
          .toString("utf8");
        if (gotUser !== user || gotPass !== password) {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
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
            const length = request[offset++]!;
            host = request.subarray(offset, offset + length).toString();
            offset += length;
          } else {
            client.destroy();
            return;
          }
          const port = request.readUInt16BE(offset);
          const upstream = createServerConnection(host, port);
          const fail = () => {
            client.destroy();
            upstream.destroy();
          };
          client.once("error", fail);
          upstream.once("error", fail);
          upstream.once("connect", () => {
            client.write(
              Buffer.from([
                0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00,
              ]),
            );
            client.pipe(upstream);
            upstream.pipe(client);
          });
        });
      });
    });
  });
}

async function httpGetThroughRelay(
  relayUrl: string,
  destHost: string,
  destPort: number,
): Promise<string> {
  const parsed = mustParse(relayUrl);
  const socket = await socks5Connect(parsed, destHost, destPort);
  socket.resume();
  try {
    socket.write(
      `GET / HTTP/1.0\r\nHost: ${destHost}:${destPort}\r\nConnection: close\r\n\r\n`,
    );
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("error", reject);
      socket.once("end", () => resolve());
    });
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    socket.destroy();
  }
}

describe("authenticated proxy relay", () => {
  const servers: Closable[] = [];
  const relays: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  it("injects HTTP proxy basic auth so Chromium can stay unauthenticated", async () => {
    const origin = createOriginServer("via-http-proxy");
    servers.push(origin);
    const originPort = await listen(origin);
    const proxy = createBasicHttpConnectProxy("alice", "s3cret");
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const relay = await startAuthenticatedProxyRelay(
      mustParse(`http://alice:s3cret@127.0.0.1:${proxyPort}`),
    );
    relays.push(relay);

    const response = await httpGetThroughRelay(
      relay.url,
      "127.0.0.1",
      originPort,
    );
    expect(response).toContain("via-http-proxy");
  });

  it("rejects HTTP proxy CONNECT without the configured credentials", async () => {
    const origin = createOriginServer("hidden");
    servers.push(origin);
    const originPort = await listen(origin);
    const proxy = createBasicHttpConnectProxy("alice", "s3cret");
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const relay = await startAuthenticatedProxyRelay(
      mustParse(`http://alice:wrong@127.0.0.1:${proxyPort}`),
    );
    relays.push(relay);

    await expect(
      httpGetThroughRelay(relay.url, "127.0.0.1", originPort),
    ).rejects.toThrow(/SOCKS5: connect failed/);
  });

  it("injects SOCKS5 username/password toward the upstream proxy", async () => {
    const origin = createOriginServer("via-socks");
    servers.push(origin);
    const originPort = await listen(origin);
    const proxy = createSocks5AuthProxy("bob", "p@ss");
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const relay = await startAuthenticatedProxyRelay(
      mustParse(`socks5://bob:p%40ss@127.0.0.1:${proxyPort}`),
    );
    relays.push(relay);

    const response = await httpGetThroughRelay(
      relay.url,
      "127.0.0.1",
      originPort,
    );
    expect(response).toContain("via-socks");
  });
});
