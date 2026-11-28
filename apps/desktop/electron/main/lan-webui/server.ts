import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LanDevice } from "@pi-desktop/shared";
import { LanError, type LanChange, type LanRequest } from "./ports";
import { LABEL_MAX, MAX_DEVICES, type LanPairedDevice } from "./state";

export type LanAsset = { type: string; body: string };
export type LanServerHandler = {
  handle(request: LanRequest, key: string | null): Promise<unknown>;
  subscribe(listener: (change: LanChange) => void): () => void;
  mayReveal(sessionId: string): Promise<boolean>;
};

const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
const COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY = 300 * 1024;
const MAX_IDEMPOTENT = 200;
const HEARTBEAT_MS = 25_000;
const SESSION_COOKIE = "pi_lan";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Device = LanPairedDevice & { streams: Set<ServerResponse>; idempotent: Map<string, Promise<unknown>> };

const secret = () => randomBytes(32).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
// An open page keeps its CSRF token across restart without persisting a second secret.
const csrfFor = (token: string) => createHmac("sha256", token).update("pi-lan-csrf-v1").digest("base64url");
const liveDevice = (paired: LanPairedDevice): Device => ({ ...paired, streams: new Set(), idempotent: new Map() });

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new LanError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!size) return {};
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new LanError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LanError(400, "INVALID_ARGUMENT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LanError(400, "INVALID_ARGUMENT");
  return parsed as Record<string, unknown>;
}

/**
 * Plain-HTTP LAN listener for the browser companion. It owns pairing, device
 * credentials and the event stream; every data operation goes through the
 * workspace handler, which checks that resources belong to the local catalog.
 */
export function createLanServer(options: {
  handler: LanServerHandler;
  assets: ReadonlyMap<string, LanAsset>;
  onChange?: () => void;
  now?: () => number;
  pairings?: { devices: readonly LanPairedDevice[]; save: (devices: LanPairedDevice[]) => void };
}) {
  const now = options.now ?? Date.now;
  let server: Server | null = null;
  let host = "";
  let code: { value: string; expiresAt: number; attempts: number } | null = null;
  const devices = new Map<string, Device>();
  for (const paired of options.pairings?.devices ?? []) {
    if (paired.expiresAt > now()) devices.set(paired.id, liveDevice(paired));
  }
  const sockets = new Set<Socket>();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const changed = () => options.onChange?.();

  const deviceFor = (request: IncomingMessage): { device: Device; token: string } | null => {
    const token = cookies(request).get(SESSION_COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    pruneExpired();
    const hash = tokenHash(token);
    for (const device of devices.values()) {
      if (sameSecret(device.tokenHash, hash)) return { device, token };
    }
    return null;
  };

  function requireDevice(device: Device) {
    if (devices.get(device.id) !== device || device.expiresAt <= now()) throw new LanError(401, "UNAUTHORIZED");
  }

  /** DNS rebinding and cross-site request guard; not a TLS check. */
  const sameOrigin = (request: IncomingMessage) => {
    if (request.headers.host !== host) return false;
    const origin = request.headers.origin;
    return origin === undefined || origin === `http://${host}`;
  };

  function closeStreams(device: Device) {
    for (const stream of device.streams) stream.end();
    device.streams.clear();
  }

  function pruneExpired() {
    const time = now();
    for (const device of devices.values()) {
      if (device.expiresAt > time) continue;
      devices.delete(device.id);
      closeStreams(device);
    }
  }

  function saveDevices(next: Iterable<LanPairedDevice>) {
    options.pairings?.save(Array.from(next, ({ id, label, lastActiveAt, tokenHash, expiresAt }) => (
      { id, label, lastActiveAt, tokenHash, expiresAt }
    )));
  }

  function removeDevice(device: Device) {
    saveDevices([...devices.values()].filter(({ id }) => id !== device.id));
    devices.delete(device.id);
    closeStreams(device);
    changed();
  }

  function expireCode() {
    if (code && code.expiresAt <= now()) code = null;
  }

  async function pair(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    expireCode();
    const supplied = typeof body.code === "string" ? body.code.trim() : "";
    const label = (typeof body.label === "string" ? body.label.trim() : "").slice(0, LABEL_MAX) || "Browser";
    if (!code) throw new LanError(403, "PAIRING_CLOSED");
    if (!sameSecret(code.value, supplied)) {
      code.attempts += 1;
      if (code.attempts >= CODE_ATTEMPTS) {
        code = null;
        changed();
      }
      throw new LanError(403, "PAIRING_FAILED");
    }
    pruneExpired();
    if (devices.size >= MAX_DEVICES) throw new LanError(429, "RATE_LIMITED");

    // Save before consuming the code or issuing the cookie, without an async gap.
    const token = secret();
    const lastActiveAt = now();
    const device = liveDevice({
      id: randomUUID(), label, lastActiveAt, tokenHash: tokenHash(token), expiresAt: lastActiveAt + COOKIE_TTL_SECONDS * 1000,
    });
    saveDevices([...devices.values(), device]);
    code = null;
    devices.set(device.id, device);
    changed();
    sendJson(response, 200, { state: "paired" }, { "Set-Cookie": cookie(SESSION_COOKIE, token, COOKIE_TTL_SECONDS) });
  }

  function events(device: Device, request: IncomingMessage, response: ServerResponse, sessionFilter: string | null) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    response.write(": open\n\n");
    device.streams.add(response);
    const remove = () => device.streams.delete(response);
    request.on("close", remove);
    response.on("close", remove);
    (response as ServerResponse & { lanSession?: string | null }).lanSession = sessionFilter;
  }

  async function broadcast(change: LanChange) {
    if (![...devices.values()].some((device) => device.streams.size)) return;
    const reveal = change.sessionId && await options.handler.mayReveal(change.sessionId).catch(() => false);
    pruneExpired();
    const data = reveal ? { sessionId: change.sessionId } : {};
    for (const device of devices.values()) {
      for (const stream of device.streams) {
        const filter = (stream as ServerResponse & { lanSession?: string | null }).lanSession ?? null;
        if (filter && change.sessionId !== filter) continue;
        if (filter && !reveal) continue;
        stream.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const paired = deviceFor(request);
    if (!paired) throw new LanError(401, "UNAUTHORIZED");
    const { device, token } = paired;
    device.lastActiveAt = now();
    const method = request.method === "POST" ? "POST" : "GET";
    if (url.pathname === "/v1/me" && method === "GET") {
      // Compatibility metadata for already-open browser tabs; not per-device grants.
      const access = { deviceId: device.id, projectScope: "all-local", temporary: true, chat: true, organize: true };
      return sendJson(response, 200, { csrf: csrfFor(token), access, label: device.label });
    }
    if (method === "POST") {
      const csrf = String(request.headers["x-csrf-token"] ?? "");
      if (!sameSecret(csrfFor(token), csrf)) throw new LanError(403, "CSRF");
    }
    if (url.pathname === "/v1/logout" && method === "POST") {
      removeDevice(device);
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    if (method === "GET" && url.pathname === "/v1/events") return events(device, request, response, null);
    const sessionEvents = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (method === "GET" && sessionEvents) {
      const sessionId = decodeURIComponent(sessionEvents[1]!);
      if (!(await options.handler.mayReveal(sessionId))) throw new LanError(404, "NOT_FOUND");
      requireDevice(device);
      return events(device, request, response, sessionId);
    }
    const body = method === "POST" ? await readBody(request) : {};
    requireDevice(device);
    const lanRequest: LanRequest = { method, path: url.pathname, query: url.searchParams, body, deviceId: device.id };
    const rawKey = request.headers["idempotency-key"];
    const key = typeof rawKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(rawKey) ? rawKey : null;
    let result: Promise<unknown>;
    if (method === "POST" && key) {
      const cacheKey = `${url.pathname}:${key}`;
      const remembered = device.idempotent.get(cacheKey);
      if (remembered) {
        result = remembered;
      } else {
        result = options.handler.handle(lanRequest, key);
        device.idempotent.set(cacheKey, result);
        result.catch(() => {
          if (device.idempotent.get(cacheKey) === result) device.idempotent.delete(cacheKey);
        });
        while (device.idempotent.size > MAX_IDEMPOTENT) {
          device.idempotent.delete(device.idempotent.keys().next().value as string);
        }
      }
    } else {
      result = options.handler.handle(lanRequest, null);
    }
    const value = await result;
    requireDevice(device);
    sendJson(response, 200, value);
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${host || "localhost"}`);
    if (request.method !== "GET" && request.method !== "POST") throw new LanError(405, "METHOD_NOT_ALLOWED");
    if (!sameOrigin(request)) throw new LanError(403, "FORBIDDEN_ORIGIN");
    if (request.method === "GET") {
      const asset = options.assets.get(url.pathname === "/" ? "/index.html" : url.pathname);
      if (asset) {
        response.writeHead(200, {
          "Content-Type": asset.type,
          "Cache-Control": "no-cache",
          "Content-Security-Policy": CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        response.end(asset.body);
        return;
      }
    }
    if (url.pathname === "/pair" && request.method === "POST") return pair(request, response);
    // Older pages poll this route after pairing. It only checks the live cookie now.
    if (url.pathname === "/pair/status" && request.method === "GET") {
      if (!deviceFor(request)) throw new LanError(401, "UNAUTHORIZED");
      return sendJson(response, 200, { state: "paired" });
    }
    if (url.pathname.startsWith("/v1/")) return api(request, response, url);
    throw new LanError(404, "NOT_FOUND");
  }

  return {
    async start(address: string, port: number): Promise<{ address: string; port: number }> {
      if (server) throw new LanError(409, "ALREADY_RUNNING");
      const next = createServer((request, response) => {
        route(request, response).catch((error: unknown) => {
          const safe = error instanceof LanError ? error : new LanError(500, "FAILED");
          sendJson(response, safe.status, { code: safe.code });
        });
      });
      next.headersTimeout = 15_000;
      next.requestTimeout = 60_000;
      next.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        next.listen(port, address, () => {
          next.off("error", reject);
          resolve();
        });
      });
      const bound = next.address();
      const boundPort = typeof bound === "object" && bound ? bound.port : port;
      server = next;
      host = `${address}:${boundPort}`;
      unsubscribe = options.handler.subscribe((change) => void broadcast(change));
      heartbeat = setInterval(() => {
        pruneExpired();
        for (const device of devices.values()) for (const stream of device.streams) stream.write(": ping\n\n");
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      return { address, port: boundPort };
    },

    /** Close the listener and discard runtime state; the service owns durable intent. */
    async stop(): Promise<void> {
      const current = server;
      server = null;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      for (const device of devices.values()) closeStreams(device);
      devices.clear();
      code = null;
      host = "";
      if (!current) return;
      const closed = new Promise<void>((resolve) => current.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closed;
    },

    running: () => server !== null,
    origin: () => (host ? `http://${host}` : null),

    issueCode(): { value: string; expiresAt: number } {
      if (!server) throw new LanError(409, "NOT_RUNNING");
      code = { value: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now() + CODE_TTL_MS, attempts: 0 };
      changed();
      return { value: code.value, expiresAt: code.expiresAt };
    },

    code(): { value: string; expiresAt: number } | null {
      expireCode();
      return code ? { value: code.value, expiresAt: code.expiresAt } : null;
    },

    devices(): LanDevice[] {
      pruneExpired();
      return [...devices.values()].map(({ id, label, lastActiveAt }) => ({ id, label, lastActiveAt }));
    },

    revoke(id: string): void {
      const device = devices.get(id);
      if (!device) return;
      removeDevice(device);
    },
  };
}

export type LanServer = ReturnType<typeof createLanServer>;
