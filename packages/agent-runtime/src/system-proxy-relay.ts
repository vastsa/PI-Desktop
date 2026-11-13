import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { parseProxyUrl, type ParsedProxyUrl } from "@pi-desktop/shared";
import {
  connectTcp,
  connectViaProxy,
  proxyListenPort,
  SocketReader,
  type ProxyConnectionOptions,
} from "./socks5.js";

const MAX_PROXY_RESOLUTION_LENGTH = 8_192;
const MAX_HTTP_REQUEST_LINE_LENGTH = 16_384;

export type SystemProxyRelay = {
  url: string;
  close(): Promise<void>;
};

type ProxyRoute = { kind: "direct" } | { kind: "proxy"; proxy: ParsedProxyUrl };
type ConnectedRoute =
  | { socket: Socket; kind: "tunnel" }
  | { socket: Socket; kind: "http-forward"; proxy: ParsedProxyUrl };

/**
 * Resolve each destination through Electron's active system/PAC configuration,
 * then route traffic through that decision. The listener is loopback-only and
 * requires a per-process SOCKS credential before it will resolve a route.
 */
export async function startSystemProxyRelay(
  resolveProxy: (url: string) => Promise<string>,
  options: Pick<ProxyConnectionOptions, "lookup"> = {},
): Promise<SystemProxyRelay> {
  const password = randomBytes(32).toString("hex");
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    const forget = () => clients.delete(client);
    client.once("close", forget);
    client.once("error", forget);
    void handleClient(client, password, resolveProxy, options);
  });
  server.on("error", (error) => {
    process.stderr.write(
      `[system-proxy-relay] listener error: ${error.message}\n`,
    );
  });

  const port = await listenLoopback(server);
  return {
    url: `socks5://system-auto:${password}@127.0.0.1:${port}`,
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
        reject(new Error("system proxy relay did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function handleClient(
  client: Socket,
  expectedPassword: string,
  resolveProxy: (url: string) => Promise<string>,
  options: Pick<ProxyConnectionOptions, "lookup">,
): Promise<void> {
  const reader = new SocketReader(client);
  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  client.once("close", onClientClose);
  let connectReplySent = false;
  let guardClientError: ((error: Error) => void) | null = null;
  try {
    const { host, port } = await acceptAuthenticatedConnect(reader, client, expectedPassword);
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    connectReplySent = true;

    // SOCKS CONNECT carries no URL scheme. Wait for the first application byte
    // so PAC decisions remain correct on non-default HTTP and HTTPS ports.
    const firstByte = await reader.readExact(1);
    client.pause();
    const buffered = reader.takeBuffered();
    reader.dispose();
    guardClientError = () => client.destroy();
    client.on("error", guardClientError);
    const scheme = schemeFromFirstByte(firstByte[0]);
    const applicationData = Buffer.concat([firstByte, buffered]);
    const initialData =
      scheme === "http"
        ? await readHttpRequestPrefix(client, applicationData)
        : applicationData;
    const destination = new URL(`${scheme}://${formatHost(host)}:${port}/`);
    const resolution = await resolveProxy(destination.href);
    const route = await connectByResolvedRoute(
      parseProxyRoutes(resolution),
      host,
      port,
      scheme,
      { ...options, signal: controller.signal },
    );
    if (client.destroyed) {
      if (guardClientError) client.off("error", guardClientError);
      guardClientError = null;
      route.socket.destroy();
      return;
    }
    client.off("error", guardClientError);
    guardClientError = null;
    const forwardedData =
      route.kind === "http-forward"
        ? rewriteHttpRequestPrefix(initialData, host, port, route.proxy)
        : initialData;
    route.socket.write(forwardedData);
    pipeSockets(client, route.socket);
  } catch (error) {
    if (guardClientError) client.off("error", guardClientError);
    reader.dispose();
    if (!client.destroyed) {
      if (connectReplySent) {
        const message = (error instanceof Error ? error.message : "unknown failure")
          .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
          .slice(0, 240);
        process.stderr.write(`[system-proxy-relay] connection failed: ${message}\n`);
      }
      if (!connectReplySent) {
        try {
          client.write(
            Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
          );
        } catch {
          // The client may have closed before the SOCKS reply was sent.
        }
      }
      client.destroy();
    }
  } finally {
    client.off("close", onClientClose);
  }
}

async function acceptAuthenticatedConnect(
  reader: SocketReader,
  client: Socket,
  expectedPassword: string,
): Promise<{ host: string; port: number }> {
  const hello = await reader.readExact(2);
  if (hello[0] !== 0x05 || hello[1] === 0) {
    throw new Error("invalid SOCKS5 greeting");
  }
  const methods = await reader.readExact(hello[1]);
  if (!methods.includes(0x02)) {
    client.write(Buffer.from([0x05, 0xff]));
    throw new Error("SOCKS5 authentication is required");
  }
  client.write(Buffer.from([0x05, 0x02]));

  const auth = await reader.readExact(2);
  if (auth[0] !== 0x01 || auth[1] === 0) {
    throw new Error("invalid SOCKS5 authentication frame");
  }
  const usernameBytes = await reader.readExact(auth[1]);
  const passwordLength = await reader.readExact(1);
  if (passwordLength[0] === 0) throw new Error("empty SOCKS5 password");
  const passwordBytes = await reader.readExact(passwordLength[0]);
  const username = usernameBytes.toString("utf8");
  const suppliedPassword = passwordBytes.toString("utf8");
  const passwordMatches = secureEqual(suppliedPassword, expectedPassword);
  const usernameAllowed = username === "system-auto";
  client.write(Buffer.from([0x01, passwordMatches && usernameAllowed ? 0x00 : 0x01]));
  if (!passwordMatches || !usernameAllowed) {
    throw new Error("SOCKS5 authentication failed");
  }

  const header = await reader.readExact(4);
  if (header[0] !== 0x05 || header[1] !== 0x01) {
    throw new Error("only SOCKS5 CONNECT is supported");
  }
  const host = await readSocksAddress(reader, header[3]);
  const portBytes = await reader.readExact(2);
  const port = portBytes.readUInt16BE(0);
  if (port === 0) throw new Error("invalid SOCKS5 destination port");
  return { host, port };
}

function schemeFromFirstByte(firstByte: number): "http" | "https" {
  if (firstByte === 0x16) return "https";
  if (firstByte >= 0x41 && firstByte <= 0x5a) return "http";
  throw new Error("unsupported application protocol for system proxy routing");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function readSocksAddress(
  reader: SocketReader,
  addressType: number,
): Promise<string> {
  if (addressType === 0x01) {
    return [...(await reader.readExact(4))].join(".");
  }
  if (addressType === 0x03) {
    const length = await reader.readExact(1);
    return (await reader.readExact(length[0])).toString("utf8");
  }
  if (addressType === 0x04) {
    const bytes = await reader.readExact(16);
    const parts: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      parts.push(bytes.readUInt16BE(index).toString(16));
    }
    return parts.join(":");
  }
  throw new Error("invalid SOCKS5 destination address type");
}

function parseProxyRoutes(value: string): ProxyRoute[] {
  if (value.length > MAX_PROXY_RESOLUTION_LENGTH) {
    throw new Error("system proxy resolution is too large");
  }
  const routes: ProxyRoute[] = [];
  for (const candidate of value.split(";")) {
    const [kind, endpoint] = candidate.trim().split(/\s+/, 2);
    if (!kind) continue;
    const normalized = kind.toUpperCase();
    if (normalized === "DIRECT") {
      routes.push({ kind: "direct" });
      continue;
    }
    const scheme =
      normalized === "PROXY" || normalized === "HTTP"
        ? "http"
        : normalized === "HTTPS"
          ? "https"
          : normalized === "SOCKS" || normalized === "SOCKS5"
            ? "socks5"
            : null;
    if (!scheme || !endpoint) continue;
    const parsed = parseProxyUrl(`${scheme}://${endpoint}`);
    if (parsed.ok) routes.push({ kind: "proxy", proxy: parsed.value });
  }
  if (routes.length === 0) throw new Error("system proxy returned no usable route");
  return routes;
}

async function connectByResolvedRoute(
  routes: ProxyRoute[],
  host: string,
  port: number,
  scheme: "http" | "https",
  options: ProxyConnectionOptions,
): Promise<ConnectedRoute> {
  let lastError: unknown;
  for (const route of routes) {
    try {
      options.signal?.throwIfAborted();
      if (route.kind === "direct") {
        return { socket: await connectTcp(host, port, options), kind: "tunnel" };
      }
      if (route.proxy.isSocks || scheme === "https") {
        return {
          socket: await connectViaProxy(route.proxy, host, port, options),
          kind: "tunnel",
        };
      }
      return {
        socket: await connectHttpProxyTransport(route.proxy, options),
        kind: "http-forward",
        proxy: route.proxy,
      };
    } catch (error) {
      if (isProxyPolicyRejection(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("system proxy routes could not connect");
}

async function connectHttpProxyTransport(
  proxy: ParsedProxyUrl,
  options: ProxyConnectionOptions,
): Promise<Socket> {
  const socket = await connectTcp(proxy.host, proxyListenPort(proxy), options);
  if (proxy.scheme !== "https") return socket;
  return new Promise((resolve, reject) => {
    const secureSocket = tlsConnect({
      socket,
      host: proxy.host,
      servername: proxy.host,
    });
    const fail = (error: Error) => {
      secureSocket.destroy();
      reject(error);
    };
    secureSocket.once("error", fail);
    secureSocket.once("secureConnect", () => {
      secureSocket.off("error", fail);
      resolve(secureSocket);
    });
  });
}

async function readHttpRequestPrefix(
  client: Socket,
  initialData: Buffer,
): Promise<Buffer> {
  let data = initialData;
  while (data.indexOf(Buffer.from("\r\n")) < 0) {
    if (data.length > MAX_HTTP_REQUEST_LINE_LENGTH) {
      throw new Error("HTTP request line is too large");
    }
    data = Buffer.concat([data, await readSocketChunk(client)]);
  }
  const lineLength = data.indexOf(Buffer.from("\r\n"));
  if (lineLength > MAX_HTTP_REQUEST_LINE_LENGTH) {
    throw new Error("HTTP request line is too large");
  }
  return data;
}

function readSocketChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      socket.pause();
      resolve(chunk);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("HTTP client closed before sending a request line"));
    };
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function rewriteHttpRequestPrefix(
  data: Buffer,
  host: string,
  port: number,
  proxy: ParsedProxyUrl,
): Buffer {
  const delimiter = Buffer.from("\r\n");
  const lineEnd = data.indexOf(delimiter);
  if (lineEnd < 0) throw new Error("HTTP request line is incomplete");
  const line = data.subarray(0, lineEnd).toString("latin1");
  const match = line.match(/^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/i);
  if (!match) throw new Error("HTTP request line is invalid");
  const [, method, target, version] = match;
  const absoluteTarget = /^https?:\/\//i.test(target)
    ? target
    : `http://${formatHost(host)}:${port}${target.startsWith("/") ? target : `/${target}`}`;
  const authorization =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`, "utf8").toString("base64")}\r\n`
      : "";
  return Buffer.concat([
    Buffer.from(`${method} ${absoluteTarget} ${version}\r\n${authorization}`, "latin1"),
    data.subarray(lineEnd + delimiter.length),
  ]);
}

function isProxyPolicyRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /HTTP proxy CONNECT failed \(HTTP\/\d(?:\.\d)?\s+4\d\d\b/i.test(
      error.message,
    ) || error.message === "SOCKS5: authentication failed"
  );
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
