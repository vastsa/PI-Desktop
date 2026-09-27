import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applyNodeNetworkProxy } from "./node-proxy.js";

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
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);

    try {
      applyNodeNetworkProxy({
        mode: "custom",
        url: `socks5://127.0.0.1:${proxyPort}`,
      });
      const response = await fetch(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        signal: AbortSignal.timeout(3_000),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("model response");
    } finally {
      await close(proxy);
      await close(target);
    }
  });
});
