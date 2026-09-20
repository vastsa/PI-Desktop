/**
 * Local unauthenticated SOCKS5 listener that injects upstream proxy
 * credentials. Chromium `proxyRules` cannot contain userinfo and SOCKS5
 * username/password is not a Chromium proxy-auth scheme, so Electron main
 * points sessions at this loopback relay (issue #490).
 */
import { createServer, type Server, type Socket } from "node:net";
import type { ParsedProxyUrl } from "@pi-desktop/shared";
import { connectViaProxy, SocketReader } from "./socks5.js";

export type AuthenticatedProxyRelay = {
  port: number;
  url: string;
  close(): Promise<void>;
};

export async function startAuthenticatedProxyRelay(
  upstream: ParsedProxyUrl,
): Promise<AuthenticatedProxyRelay> {
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    const forget = () => clients.delete(client);
    client.once("close", forget);
    client.once("error", forget);
    void handleClient(client, upstream);
  });
  server.on("error", () => {
    // Accept errors are surfaced per-connection; listen() uses the callback.
  });

  const port = await listenLoopback(server);
  return {
    port,
    url: `socks5://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.destroy();
        clients.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("proxy relay did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function handleClient(
  client: Socket,
  upstream: ParsedProxyUrl,
): Promise<void> {
  const reader = new SocketReader(client);
  try {
    const dest = await acceptSocks5Connect(reader, client);
    const remote = await connectViaProxy(upstream, dest.host, dest.port);
    reader.dispose();
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    pipeSockets(client, remote);
  } catch {
    reader.dispose();
    if (!client.destroyed) {
      try {
        client.write(
          Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
        );
      } catch {
        // The client may already be gone.
      }
      client.destroy();
    }
  }
}

async function acceptSocks5Connect(
  reader: SocketReader,
  client: Socket,
): Promise<{ host: string; port: number }> {
  const hello = await reader.readExact(2);
  if (hello[0] !== 0x05) throw new Error("SOCKS5: invalid version");
  const nmethods = hello[1];
  if (nmethods > 0) await reader.readExact(nmethods);
  client.write(Buffer.from([0x05, 0x00]));

  const header = await reader.readExact(4);
  if (header[0] !== 0x05 || header[1] !== 0x01) {
    throw new Error("SOCKS5: only CONNECT is supported");
  }
  const host = await readSocksAddress(reader, header[3]);
  const portBuf = await reader.readExact(2);
  return { host, port: portBuf.readUInt16BE(0) };
}

async function readSocksAddress(
  reader: SocketReader,
  atyp: number,
): Promise<string> {
  if (atyp === 0x01) {
    const bytes = await reader.readExact(4);
    return [...bytes].join(".");
  }
  if (atyp === 0x03) {
    const len = await reader.readExact(1);
    const name = await reader.readExact(len[0]);
    return name.toString("utf8");
  }
  if (atyp === 0x04) {
    const bytes = await reader.readExact(16);
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(bytes.readUInt16BE(i).toString(16));
    }
    return parts.join(":");
  }
  throw new Error("SOCKS5: unknown address type");
}

function pipeSockets(left: Socket, right: Socket): void {
  const closeBoth = () => {
    left.destroy();
    right.destroy();
  };
  left.once("error", closeBoth);
  right.once("error", closeBoth);
  left.once("close", () => right.destroy());
  right.once("close", () => left.destroy());
  left.pipe(right);
  right.pipe(left);
}
