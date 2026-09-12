/**
 * Apply the user proxy to Node's global fetch (undici).
 *
 * Electron main uses Chromium `net.fetch` instead. The sidecar has no
 * Chromium session, so LLM provider calls go through this dispatcher.
 * HTTP(S) proxies use undici `ProxyAgent`; SOCKS5 uses a CONNECT tunnel
 * plus the same undici `fetch` so the dispatcher and fetch implementation
 * stay on one package (OpenAI's undici mismatch warning).
 */
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import {
  applyProxyEnvAssignments,
  effectiveProxyBypass,
  parseProxyUrl,
  proxyEnvAssignments,
  type NetworkProxySettings,
  type ParsedProxyUrl,
} from "@pi-desktop/shared";
import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type buildConnector,
} from "undici";

let originalFetch: typeof fetch | null = null;
let originalDispatcher: Dispatcher | null = null;
let installed = false;
let activeDispatcher: Dispatcher | null = null;
/** Plain agent the bypass list routes to; closed together with the proxy. */
let activeDirectDispatcher: Dispatcher | null = null;

function ensurePatched(): void {
  if (installed) return;
  installed = true;
  originalFetch = globalThis.fetch;
  originalDispatcher = getGlobalDispatcher();
}

function closeActiveDispatchers(): void {
  if (activeDispatcher && typeof activeDispatcher.close === "function") {
    void activeDispatcher.close();
  }
  if (activeDirectDispatcher && typeof activeDirectDispatcher.close === "function") {
    void activeDirectDispatcher.close();
  }
  activeDispatcher = null;
  activeDirectDispatcher = null;
}

function restoreDefault(): void {
  closeActiveDispatchers();
  if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
  else setGlobalDispatcher(new Agent());
  if (originalFetch) globalThis.fetch = originalFetch;
}

export function applyNodeNetworkProxy(
  settings: NetworkProxySettings,
  env: Record<string, string | undefined> = process.env,
): void {
  ensurePatched();
  applyProxyEnvAssignments(proxyEnvAssignments(settings), env);
  if (settings.mode !== "custom") {
    restoreDefault();
    return;
  }
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok) {
    restoreDefault();
    return;
  }
  const proxied: Dispatcher = parsed.value.isSocks
    ? new Agent({ connect: socksConnector(parsed.value) })
    : new ProxyAgent(parsed.value.href);
  const direct = new Agent();
  const bypass = proxyBypassMatcher(effectiveProxyBypass(settings));
  // Origins on the bypass list go to the plain agent, everything else through
  // the proxy. Same list Electron main hands Chromium as `proxyBypassRules`.
  const dispatcher = proxied.compose(
    (next) => (options, handler) =>
      originIsBypassed(options.origin, bypass)
        ? direct.dispatch(options, handler)
        : next(options, handler),
  );
  closeActiveDispatchers();
  activeDispatcher = dispatcher;
  activeDirectDispatcher = direct;
  setGlobalDispatcher(dispatcher);
  globalThis.fetch = undiciFetch as unknown as typeof fetch;
}

export type ProxyBypassMatcher = (hostname: string, port: number) => boolean;

function originIsBypassed(
  origin: string | URL | undefined,
  bypass: ProxyBypassMatcher,
): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = typeof origin === "string" ? new URL(origin) : origin;
  } catch {
    return false;
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:" || url.protocol === "wss:"
      ? 443
      : 80;
  return bypass(url.hostname, port);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4ToInt(host: string): number | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = ipv4ToInt(host);
  return ipv4 !== null && ipv4 >>> 24 === 127;
}

type BypassRule = (hostname: string, port: number) => boolean;

/**
 * One rule from a Chromium-style bypass list: `host`, `.suffix`, `*.suffix`,
 * `*suffix`, `host:port`, an IP literal, an IPv4 CIDR block, or `<local>`.
 * A bare hostname also covers its subdomains, matching the `NO_PROXY`
 * convention the same list is exported under for child processes.
 */
function parseBypassRule(raw: string): BypassRule | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (entry === "<local>") {
    // Simple hostnames (no dot) plus loopback; IPv6 literals have no dot
    // either but are addresses, not local names.
    return (hostname) =>
      (!hostname.includes(".") && !hostname.includes(":")) ||
      isLoopbackHost(hostname);
  }
  let hostPart = entry;
  let port: number | undefined;
  const bracketed = entry.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (bracketed) {
    hostPart = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if ((entry.match(/:/g) ?? []).length === 1) {
    const [host, portText] = entry.split(":");
    if (portText && /^\d+$/.test(portText)) {
      hostPart = host;
      port = Number(portText);
    }
  }
  const portMatches = (candidate: number) => port === undefined || port === candidate;
  const cidr = hostPart.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const network = ipv4ToInt(cidr[1]);
    const bits = Number(cidr[2]);
    if (network === null || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (hostname, candidatePort) => {
      const address = ipv4ToInt(hostname);
      return (
        address !== null &&
        ((address & mask) >>> 0) === ((network & mask) >>> 0) &&
        portMatches(candidatePort)
      );
    };
  }
  let host = normalizeHost(hostPart);
  let wildcard = false;
  while (host.startsWith("*")) {
    wildcard = true;
    host = host.slice(1);
  }
  const suffixOnly = host.startsWith(".");
  host = host.replace(/^\.+/, "");
  if (!host) return null;
  if (wildcard && !suffixOnly) {
    // `*foo.com`: any host ending in the text, including `foo.com` itself.
    return (hostname, candidatePort) =>
      hostname.endsWith(host) && portMatches(candidatePort);
  }
  return (hostname, candidatePort) =>
    (hostname === host || hostname.endsWith(`.${host}`)) &&
    portMatches(candidatePort);
}

/** Compile a comma-separated bypass list into a host/port predicate. */
export function proxyBypassMatcher(bypass: string): ProxyBypassMatcher {
  const rules = bypass
    .split(",")
    .map((entry) => parseBypassRule(entry))
    .filter((rule): rule is BypassRule => rule !== null);
  return (hostname, port) => {
    const host = normalizeHost(hostname);
    if (!host) return false;
    return rules.some((rule) => rule(host, port));
  };
}

function socksConnector(proxy: ParsedProxyUrl): buildConnector.connector {
  return (options, callback) => {
    const hostname = options.hostname || options.host || "";
    const port = Number(options.port) || (options.protocol === "http:" ? 80 : 443);
    void socks5Connect(proxy, hostname, port)
      .then((socket) => {
        if (options.protocol === "https:") {
          const tlsSocket = tlsConnect({
            socket,
            host: hostname,
            servername: options.servername || hostname,
            ALPNProtocols: ["http/1.1"],
          });
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
          tlsSocket.once("error", (error) => callback(error, null));
          return;
        }
        callback(null, socket);
      })
      .catch((error: Error) => callback(error, null));
  };
}

async function socks5Connect(
  proxy: ParsedProxyUrl,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  const proxyPort =
    proxy.port ??
    (proxy.scheme === "http" || proxy.scheme === "https" ? 80 : 1080);
  const socket = await connectTcp(proxy.host, proxyPort);
  const reader = new SocketReader(socket);
  try {
    const methods =
      proxy.username || proxy.password
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(methods);
    const choice = await reader.readExact(2);
    if (choice[0] !== 0x05) {
      throw new Error("SOCKS5: invalid version");
    }
    if (choice[1] === 0x02) {
      const user = Buffer.from(proxy.username ?? "", "utf8");
      const pass = Buffer.from(proxy.password ?? "", "utf8");
      if (user.length > 255 || pass.length > 255) {
        throw new Error("SOCKS5: credentials too long");
      }
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ]),
      );
      const auth = await reader.readExact(2);
      if (auth[1] !== 0x00) throw new Error("SOCKS5: authentication failed");
    } else if (choice[1] !== 0x00) {
      throw new Error("SOCKS5: no acceptable authentication");
    }

    const dest = encodeSocksHost(destHost);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(destPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), dest, port]));
    const header = await reader.readExact(4);
    if (header[1] !== 0x00) {
      throw new Error(`SOCKS5: connect failed (${header[1]})`);
    }
    await readSocksBind(reader, header[3]);
    reader.dispose();
    return socket;
  } catch (error) {
    reader.dispose();
    socket.destroy();
    throw error;
  }
}

function encodeSocksHost(host: string): Buffer {
  if (host.includes(":") && !host.includes(".")) {
    const buf = Buffer.alloc(17);
    buf[0] = 0x04;
    // Expand IPv6 shorthand via the WHATWG URL parser.
    const parsed = new URL(`http://[${host.replace(/^\[|\]$/g, "")}]`);
    const bytes = parsed.hostname.includes(":")
      ? ipv6ToBytes(parsed.hostname)
      : null;
    if (!bytes) throw new Error("SOCKS5: invalid IPv6 host");
    bytes.copy(buf, 1);
    return buf;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const buf = Buffer.from([
      0x01,
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4]),
    ]);
    return buf;
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error("SOCKS5: hostname too long");
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function ipv6ToBytes(host: string): Buffer | null {
  const hex = host.split(":");
  if (hex.length > 8) return null;
  const buf = Buffer.alloc(16);
  let skip = hex.indexOf("");
  let filled = 0;
  if (skip === -1) {
    if (hex.length !== 8) return null;
    for (let i = 0; i < 8; i += 1) {
      const n = Number.parseInt(hex[i] || "0", 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      buf.writeUInt16BE(n, i * 2);
    }
    return buf;
  }
  const head = hex.slice(0, skip).filter(Boolean);
  const tail = hex.slice(skip + 1).filter(Boolean);
  if (head.length + tail.length > 7) return null;
  for (const part of head) {
    const n = Number.parseInt(part, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    buf.writeUInt16BE(n, filled);
    filled += 2;
  }
  filled = 16 - tail.length * 2;
  for (const part of tail) {
    const n = Number.parseInt(part, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    buf.writeUInt16BE(n, filled);
    filled += 2;
  }
  return buf;
}

async function readSocksBind(reader: SocketReader, atyp: number): Promise<void> {
  if (atyp === 0x01) await reader.readExact(4 + 2);
  else if (atyp === 0x04) await reader.readExact(16 + 2);
  else if (atyp === 0x03) {
    const len = await reader.readExact(1);
    await reader.readExact(len[0] + 2);
  } else {
    throw new Error("SOCKS5: unknown address type");
  }
}

function connectTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

class SocketReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: Array<{
    size: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    this.drain();
  };

  private readonly onError = (error: Error) => {
    this.fail(error);
  };

  private readonly onClose = () => {
    this.fail(new Error("SOCKS5: connection closed"));
  };

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  readExact(size: number): Promise<Buffer> {
    if (size <= 0) return Promise.resolve(Buffer.alloc(0));
    if (this.buffer.length >= size) return Promise.resolve(this.take(size));
    if (this.closed) {
      return Promise.reject(new Error("SOCKS5: connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ size, resolve, reject });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.buffer.length > 0) {
      this.socket.unshift(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.socket.pause();
  }

  private take(size: number): Buffer {
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (this.buffer.length < waiter.size) return;
      this.waiters.shift();
      waiter.resolve(this.take(waiter.size));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}
