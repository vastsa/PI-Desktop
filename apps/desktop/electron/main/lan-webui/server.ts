import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LanAccess, LanDevice, LanGrants, LanPairing } from "@pi-desktop/shared";
import { LanError, type LanChange, type LanRequest } from "./ports";

export type LanAsset = { type: string; body: string };
export type LanServerHandler = {
  handle(request: LanRequest, key: string | null): Promise<unknown>;
  subscribe(listener: (change: LanChange) => void): () => void;
  mayReveal(access: LanAccess, sessionId: string): Promise<boolean>;
};

const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 8;
const MAX_DEVICES = 16;
const MAX_BODY = 300 * 1024;
const MAX_IDEMPOTENT = 200;
const HEARTBEAT_MS = 25_000;
const LABEL_MAX = 60;
const SESSION_COOKIE = "pi_lan";
const PENDING_COOKIE = "pi_lan_pending";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Device = LanDevice & { token: string; csrf: string; streams: Set<ServerResponse>; idempotent: Map<string, Promise<unknown>> };
type Pending = LanPairing & { secret: string; deviceId: string | null };

const secret = () => randomBytes(32).toString("base64url");
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
 * workspace handler, which re-checks the device's scope.
 */
export function createLanServer(options: {
  handler: LanServerHandler;
  assets: ReadonlyMap<string, LanAsset>;
  onChange?: () => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let server: Server | null = null;
  let host = "";
  let code: { value: string; expiresAt: number; attempts: number } | null = null;
  const pending = new Map<string, Pending>();
  const devices = new Map<string, Device>();
  const sockets = new Set<Socket>();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const changed = () => options.onChange?.();

  const deviceFor = (request: IncomingMessage): Device | null => {
    const token = cookies(request).get(SESSION_COOKIE);
    if (!token) return null;
    for (const device of devices.values()) if (sameSecret(device.token, token)) return device;
    return null;
  };

  const access = (device: Device): LanAccess => ({ deviceId: device.id, ...device.grants });

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

  function prune() {
    const time = now();
    if (code && code.expiresAt <= time) code = null;
    for (const [id, entry] of pending) if (time - entry.createdAt > PENDING_TTL_MS) pending.delete(id);
  }

  async function pair(request: IncomingMessage, response: ServerResponse) {
    prune();
    const body = await readBody(request);
    const supplied = typeof body.code === "string" ? body.code.trim() : "";
    const label = (typeof body.label === "string" ? body.label.trim() : "").slice(0, LABEL_MAX) || "Browser";
    if (!code) throw new LanError(403, "PAIRING_CLOSED");
    if (!sameSecret(code.value, supplied)) {
      code.attempts += 1;
      if (code.attempts >= CODE_ATTEMPTS) code = null;
      changed();
      throw new LanError(403, "PAIRING_FAILED");
    }
    if (pending.size >= MAX_PENDING) throw new LanError(429, "RATE_LIMITED");
    code = null; // single use
    const entry: Pending = { id: randomUUID(), label, createdAt: now(), secret: secret(), deviceId: null };
    pending.set(entry.id, entry);
    changed();
    sendJson(response, 200, { state: "pending" }, { "Set-Cookie": cookie(PENDING_COOKIE, entry.secret, PENDING_TTL_MS / 1000) });
  }

  function pairStatus(request: IncomingMessage, response: ServerResponse) {
    prune();
    const token = cookies(request).get(PENDING_COOKIE);
    const entry = token ? [...pending.values()].find((candidate) => sameSecret(candidate.secret, token)) : undefined;
    if (!entry) {
      const device = deviceFor(request);
      if (device) return sendJson(response, 200, { state: "paired" });
      throw new LanError(401, "UNAUTHORIZED");
    }
    if (!entry.deviceId) return sendJson(response, 200, { state: "pending" });
    const device = devices.get(entry.deviceId);
    pending.delete(entry.id);
    if (!device) throw new LanError(401, "UNAUTHORIZED");
    sendJson(response, 200, { state: "paired" }, {
      "Set-Cookie": [cookie(SESSION_COOKIE, device.token, 12 * 60 * 60), cookie(PENDING_COOKIE, "", 0)],
    });
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
    for (const device of devices.values()) {
      if (!device.streams.size) continue;
      let reveal = false;
      if (change.sessionId) reveal = await options.handler.mayReveal(access(device), change.sessionId).catch(() => false);
      if (!devices.has(device.id)) continue;
      for (const stream of device.streams) {
        const filter = (stream as ServerResponse & { lanSession?: string | null }).lanSession ?? null;
        if (filter && change.sessionId !== filter) continue;
        if (filter && !reveal) continue;
        const data = reveal ? { sessionId: change.sessionId } : {};
        stream.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const device = deviceFor(request);
    if (!device) throw new LanError(401, "UNAUTHORIZED");
    device.lastActiveAt = now();
    const method = request.method === "POST" ? "POST" : "GET";
    if (url.pathname === "/v1/me" && method === "GET") {
      return sendJson(response, 200, { csrf: device.csrf, access: access(device), label: device.label });
    }
    if (method === "POST") {
      const csrf = String(request.headers["x-csrf-token"] ?? "");
      if (!sameSecret(device.csrf, csrf)) throw new LanError(403, "CSRF");
    }
    if (url.pathname === "/v1/logout" && method === "POST") {
      closeStreams(device);
      devices.delete(device.id);
      changed();
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    if (method === "GET" && url.pathname === "/v1/events") return events(device, request, response, null);
    const sessionEvents = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (method === "GET" && sessionEvents) {
      const sessionId = decodeURIComponent(sessionEvents[1]!);
      if (!(await options.handler.mayReveal(access(device), sessionId))) throw new LanError(404, "NOT_FOUND");
      return events(device, request, response, sessionId);
    }
    const body = method === "POST" ? await readBody(request) : {};
    const lanRequest: LanRequest = { method, path: url.pathname, query: url.searchParams, body, access: access(device) };
    const rawKey = request.headers["idempotency-key"];
    const key = typeof rawKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(rawKey) ? rawKey : null;
    let result: Promise<unknown>;
    if (method === "POST" && key) {
      const remembered = device.idempotent.get(`${url.pathname}:${key}`);
      if (remembered) {
        result = remembered;
      } else {
        result = options.handler.handle(lanRequest, key);
        device.idempotent.set(`${url.pathname}:${key}`, result);
        result.catch(() => device.idempotent.delete(`${url.pathname}:${key}`));
        while (device.idempotent.size > MAX_IDEMPOTENT) {
          device.idempotent.delete(device.idempotent.keys().next().value as string);
        }
      }
    } else {
      result = options.handler.handle(lanRequest, null);
    }
    const value = await result;
    // A device revoked while the request ran gets no data back.
    if (!devices.has(device.id)) throw new LanError(401, "UNAUTHORIZED");
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
    if (url.pathname === "/pair/status" && request.method === "GET") return pairStatus(request, response);
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
        for (const device of devices.values()) for (const stream of device.streams) stream.write(": ping\n\n");
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      return { address, port: boundPort };
    },

    /** Stopping invalidates every pairing and device credential. */
    async stop(): Promise<void> {
      const current = server;
      server = null;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      for (const device of devices.values()) closeStreams(device);
      devices.clear();
      pending.clear();
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
      return { value: code.value, expiresAt: code.expiresAt };
    },

    code(): { value: string; expiresAt: number } | null {
      prune();
      return code ? { value: code.value, expiresAt: code.expiresAt } : null;
    },

    pending(): LanPairing[] {
      prune();
      return [...pending.values()].filter((entry) => !entry.deviceId).map(({ id, label, createdAt }) => ({ id, label, createdAt }));
    },

    devices(): LanDevice[] {
      return [...devices.values()].map(({ id, label, lastActiveAt, grants }) => ({ id, label, lastActiveAt, grants }));
    },

    /** Desktop confirmation: the only path that turns a pending browser into a device. */
    confirm(id: string, grants: LanGrants): void {
      const entry = pending.get(id);
      if (!entry || entry.deviceId) throw new LanError(404, "NOT_FOUND");
      if (devices.size >= MAX_DEVICES) throw new LanError(429, "RATE_LIMITED");
      const device: Device = {
        id: randomUUID(),
        label: entry.label,
        lastActiveAt: now(),
        grants: {
          projectIds: [...new Set(grants.projectIds.filter((value) => typeof value === "string"))],
          temporary: grants.temporary === true,
          chat: grants.chat === true,
          organize: grants.organize === true,
        },
        token: secret(),
        csrf: secret(),
        streams: new Set(),
        idempotent: new Map(),
      };
      devices.set(device.id, device);
      entry.deviceId = device.id;
      changed();
    },

    deny(id: string): void {
      pending.delete(id);
      changed();
    },

    revoke(id: string): void {
      const device = devices.get(id);
      if (!device) return;
      closeStreams(device);
      devices.delete(id);
      changed();
    },
  };
}

export type LanServer = ReturnType<typeof createLanServer>;
