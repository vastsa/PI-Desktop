/**
 * Outbound SOCKS5 and HTTP CONNECT tunnels used by the sidecar dispatcher
 * and by the Chromium auth relay (issue #490).
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ParsedProxyUrl } from "@pi-desktop/shared";

export function proxyListenPort(proxy: ParsedProxyUrl): number {
  if (proxy.port) return proxy.port;
  if (proxy.scheme === "https") return 443;
  if (proxy.scheme === "http") return 80;
  return 1080;
}

export function connectTarget(host: string, port: number): string {
  const wrapped =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${wrapped}:${port}`;
}

export async function connectViaProxy(
  proxy: ParsedProxyUrl,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  return proxy.isSocks
    ? socks5Connect(proxy, destHost, destPort)
    : httpProxyConnect(proxy, destHost, destPort);
}

export async function socks5Connect(
  proxy: ParsedProxyUrl,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  const socket = await connectTcp(proxy.host, proxyListenPort(proxy));
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

export async function httpProxyConnect(
  proxy: ParsedProxyUrl,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  const raw = await connectTcp(proxy.host, proxyListenPort(proxy));
  const socket =
    proxy.scheme === "https" ? await tlsWrap(raw, proxy.host) : raw;
  const reader = new SocketReader(socket);
  try {
    const target = connectTarget(destHost, destPort);
    let extra = "";
    if (proxy.username || proxy.password) {
      const token = Buffer.from(
        `${proxy.username}:${proxy.password}`,
        "utf8",
      ).toString("base64");
      extra += `Proxy-Authorization: Basic ${token}\r\n`;
    }
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}Proxy-Connection: Keep-Alive\r\n\r\n`,
    );
    const header = await reader.readUntil(Buffer.from("\r\n\r\n"));
    const status = header.toString("latin1").split("\r\n", 1)[0] ?? "";
    const match = status.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    if (!match || match[1] !== "200") {
      throw new Error(`HTTP proxy CONNECT failed (${status.trim() || "empty"})`);
    }
    reader.dispose();
    return socket;
  } catch (error) {
    reader.dispose();
    socket.destroy();
    throw error;
  }
}

function tlsWrap(socket: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      host,
      servername: host,
    });
    const onError = (error: Error) => {
      tlsSocket.destroy();
      reject(error);
    };
    tlsSocket.once("error", onError);
    tlsSocket.once("secureConnect", () => {
      tlsSocket.off("error", onError);
      resolve(tlsSocket);
    });
  });
}

function encodeSocksHost(host: string): Buffer {
  if (host.includes(":") && !host.includes(".")) {
    const buf = Buffer.alloc(17);
    buf[0] = 0x04;
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
    return Buffer.from([
      0x01,
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4]),
    ]);
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

export function connectTcp(host: string, port: number): Promise<Socket> {
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

export class SocketReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: Array<{
    size: number | Buffer;
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

  /** Include the delimiter in the returned buffer. */
  readUntil(delimiter: Buffer): Promise<Buffer> {
    const found = this.indexOf(delimiter);
    if (found >= 0) return Promise.resolve(this.take(found + delimiter.length));
    if (this.closed) {
      return Promise.reject(new Error("SOCKS5: connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ size: delimiter, resolve, reject });
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

  private indexOf(delimiter: Buffer): number {
    return this.buffer.indexOf(delimiter);
  }

  private take(size: number): Buffer {
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (typeof waiter.size === "number") {
        if (this.buffer.length < waiter.size) return;
        this.waiters.shift();
        waiter.resolve(this.take(waiter.size));
        continue;
      }
      const found = this.indexOf(waiter.size);
      if (found < 0) {
        if (this.buffer.length > 65_536) {
          this.waiters.shift();
          waiter.reject(new Error("SOCKS5: header too large"));
        }
        return;
      }
      this.waiters.shift();
      waiter.resolve(this.take(found + waiter.size.length));
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
