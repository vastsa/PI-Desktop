/**
 * Loopback proxy that authenticates git's smart-HTTP traffic to GitHub.
 *
 * The GitHub token lives in this process's memory only. git on the host (the
 * host-core's own clone, fetch, and push, and the agent's `git` inside Bash)
 * never sees it: a per-command URL rewrite sends one repository's traffic to
 * `http://127.0.0.1:<port>/<handle>/<owner>/<repo>.git/...`, and this proxy
 * adds the credential on the way to GitHub.
 *
 * A handle is not the token, and it is not a secret from other local users:
 * git puts the proxy URL in the arguments of its `git remote-http` helper, in
 * `.git/FETCH_HEAD`, and in its own output. What protects it:
 *
 * - the listener is loopback-only;
 * - a connection is served only when the process that opened it runs as the
 *   same user as `pi-host` (Linux; see `loopback-peer.ts`);
 * - a handle works only for the repository of the session it was issued for,
 *   and for a push only to that session's work branch;
 * - every credential set replaces the installation's handles.
 *
 * When the owning desktop disconnects the token is dropped and the proxy
 * answers 401.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { constants as zlibConstants, gunzipSync } from "node:zlib";

import type { WorkspaceGitRepository } from "@pi-desktop/shared";

import { parseReceivePackCommands } from "./git-receive-pack.js";
import { createLoopbackPeerUidLookup, type LoopbackPeerUidLookup } from "./loopback-peer.js";
import { sendUpstreamRequest, type UpstreamTlsOptions } from "./upstream-proxy.js";

export type GitProxyScope = { installationId: string; sessionId: string; repository: WorkspaceGitRepository; workBranch: string };

export type GitCredentialProxy = {
  /** Bind 127.0.0.1 on a free port. */
  start(): Promise<void>;
  close(): Promise<void>;
  /**
   * Setting a token invalidates every handle of that installation; the next
   * `register` mints new ones. Dropping it (`null`) keeps them: they answer 401.
   */
  setToken(installationId: string, token: string | null): void;
  /** Returns `http://127.0.0.1:<port>/<handle>/`; the same scope keeps its handle until the next credential set. */
  register(scope: GitProxyScope): string;
  unregister(installationId: string, sessionId: string): void;
  /** An unauthenticated connection gets a URL that only answers 401. */
  unauthorizedUrl?(): string | undefined;
};

type ProxyLog = (level: "info" | "warn", message: string, data?: unknown) => void;

const DEFAULT_UPSTREAM = "https://github.com";
/** How much of a push the proxy reads to find the end of the command section. */
const COMMAND_SECTION_LIMIT = 64 * 1024;
/** Decoded size the buffered prefix of a gzip body may reach before it is refused. */
const GZIP_DECODE_LIMIT = 4 * 1024 * 1024;
/** `0000`: a body that is only this is git's empty probe request. */
const FLUSH_PACKET_LENGTH = 4;
const HANDLE = /^[0-9a-f]{64}$/u;
/** Paths git builds from an owner, a repository, and a fixed endpoint need nothing else. */
const SAFE_PATH = /^(?:\/[A-Za-z0-9._~-]+)+\/?$/u;
const SAFE_QUERY = /^[A-Za-z0-9._~=&-]*$/u;
const REFUSED_DRAIN_MS = 30_000;
const INSPECTION_IDLE_MS = 30_000;

/** Never forwarded to GitHub: the client's own credentials, and hop-by-hop headers. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization", "cookie", "proxy-authorization", "host", "connection", "keep-alive", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "expect",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

type Endpoint = "info/refs" | "upload-pack" | "receive-pack" | "lfs";

/**
 * The exact requests of the scoped repository that carry the credential.
 * Everything else under the same handle is forwarded anonymously, so a path or
 * query GitHub might read differently than this proxy never has the token.
 */
function credentialedEndpoint(method: string, subPath: string, query: string | undefined): Endpoint | null {
  if (method === "GET" && subPath === "info/refs" && (query === "service=git-upload-pack" || query === "service=git-receive-pack")) return "info/refs";
  if (method !== "POST" || query !== undefined) return null;
  if (subPath === "git-upload-pack") return "upload-pack";
  if (subPath === "git-receive-pack") return "receive-pack";
  if (subPath === "info/lfs/objects/batch" || subPath === "info/lfs/locks/verify") return "lfs";
  return null;
}

type Inspection = { ok: true; buffered: Buffer[]; ended: boolean } | { ok: false; reason: string };

/**
 * Read a push up to the end of its command section and check every ref.
 * Nothing is sent upstream until this resolves `ok`.
 */
function inspectReceivePack(req: IncomingMessage, workBranch: string): Promise<Inspection> {
  const encoding = String(req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") return Promise.resolve({ ok: false, reason: "unsupported content encoding" });
  const allowed = `refs/heads/${workBranch}`;
  return new Promise((resolve) => {
    const buffered: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: Inspection) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      clearTimeout(idle);
      req.pause();
      resolve(result);
    };
    const check = (ended: boolean) => {
      const raw = Buffer.concat(buffered);
      let decoded = raw;
      if (encoding === "gzip") {
        try {
          // A sync flush decodes the bytes received so far of a body that has not ended.
          decoded = gunzipSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: GZIP_DECODE_LIMIT });
        } catch {
          return settle({ ok: false, reason: "the request body could not be decoded" });
        }
      }
      const parsed = parseReceivePackCommands(decoded.subarray(0, COMMAND_SECTION_LIMIT));
      if (parsed.malformed) return settle({ ok: false, reason: "the push is not a receive-pack request" });
      if (parsed.refs.some((ref) => ref !== allowed)) return settle({ ok: false, reason: `this session may only push ${allowed}` });
      if (parsed.complete) {
        if (parsed.refs.length > 0) return settle({ ok: true, buffered, ended });
        // For a pack larger than `http.postBuffer`, git first POSTs a body
        // that is exactly one flush packet, to settle authentication before
        // it streams the real request. It carries no command and changes
        // nothing; refusing it would fail every large push.
        if (decoded.length === FLUSH_PACKET_LENGTH) {
          if (ended) return settle({ ok: true, buffered, ended });
          return;
        }
        return settle({ ok: false, reason: "the push names no ref" });
      }
      if (ended || size >= COMMAND_SECTION_LIMIT || decoded.length >= COMMAND_SECTION_LIMIT) {
        return settle({ ok: false, reason: "the push's ref updates did not end within 64 KiB" });
      }
    };
    const onData = (chunk: Buffer) => {
      idle.refresh();
      buffered.push(chunk);
      size += chunk.length;
      check(false);
    };
    const onEnd = () => check(true);
    const onError = () => settle({ ok: false, reason: "the request was interrupted" });
    const idle = setTimeout(() => settle({ ok: false, reason: "the push stalled before its ref updates were complete" }), INSPECTION_IDLE_MS).unref();
    req.on("data", onData);
    req.on("aborted", onError);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * `upstream` defaults to `https://github.com`. It exists for tests and is
 * settable only through this argument: no flag, environment variable, or RPC
 * can point the credential at another server.
 */
export type GitCredentialProxyOptions = {
  upstream?: string;
  log?: ProxyLog;
  /**
   * The uid that owns the client end of a loopback connection, for tests.
   * By default the kernel's socket table on Linux; no check elsewhere.
   */
  peerUid?: LoopbackPeerUidLookup;
  /** Environment used for HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY lookup. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Optional TLS overrides for upstream HTTPS connections (e.g. a test CA certificate). */
  upstreamTls?: UpstreamTlsOptions;
};

export function createGitCredentialProxy(options: GitCredentialProxyOptions = {}): GitCredentialProxy {
  const upstream = new URL(options.upstream ?? DEFAULT_UPSTREAM);
  const upstreamBasePath = upstream.pathname.replace(/\/+$/u, "");
  const log: ProxyLog = options.log ?? (() => undefined);
  const tokens = new Map<string, string>();
  const scopes = new Map<string, GitProxyScope>();
  const handles = new Map<string, string>();
  const unauthorizedHandle = randomBytes(32).toString("hex");
  const scopeKey = (installationId: string, sessionId: string) => JSON.stringify([installationId, sessionId]);
  let server: Server | null = null;
  let port = 0;
  const ownUid = typeof process.getuid === "function" ? process.getuid() : null;
  const peerUid = options.peerUid ?? (process.platform === "linux" ? createLoopbackPeerUidLookup() : null);

  const reply = (res: ServerResponse, status: number, message: string) => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    res.end(`${message}\n`);
  };
  /** Answer now; let a client that is still uploading notice, then let go of it. */
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, message: string) => {
    reply(res, status, message);
    req.resume();
    setTimeout(() => req.destroy(), REFUSED_DRAIN_MS).unref();
  };

  const forward = (req: IncomingMessage, res: ServerResponse, path: string, authorization: string | null, body: { buffered: Buffer[]; ended: boolean } | null, sessionId: string) => {
    const headers = forwardedHeaders(req.headers);
    if (authorization) headers.authorization = authorization;
    const outbound = sendUpstreamRequest({
      upstream,
      method: req.method,
      path: `${upstreamBasePath}${path}`,
      headers,
      env: options.env,
      upstreamTls: options.upstreamTls,
    }, {
      onReady(clientReq) {
        for (const chunk of body?.buffered ?? []) clientReq.write(chunk);
        if (body?.ended || req.readableEnded) clientReq.end();
        else req.pipe(clientReq);
      },
      onResponse(inbound) {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(inbound.headers)) {
          if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
        }
        res.writeHead(inbound.statusCode ?? 502, responseHeaders);
        inbound.pipe(res);
        inbound.on("error", () => res.destroy());
      },
      onError(error) {
        // The message of a socket error names a host or an errno, never a path or credential.
        log("warn", "git proxy upstream request failed", { sessionId, error: (error as NodeJS.ErrnoException).code ?? "ERROR" });
        reply(res, 502, "pi-host git proxy: GitHub could not be reached");
      },
    });
    res.on("close", () => { if (!res.writableEnded) outbound.destroy(); });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? "/";
    const mark = raw.indexOf("?");
    const rawPath = mark < 0 ? raw : raw.slice(0, mark);
    const query = mark < 0 ? undefined : raw.slice(mark + 1);
    const slash = rawPath.indexOf("/", 1);
    const candidate = slash < 0 ? rawPath.slice(1) : rawPath.slice(1, slash);
    if (candidate === unauthorizedHandle) {
      return refuse(req, res, 401, "pi-host git proxy: no GitHub credential for this connection");
    }
    const scope = HANDLE.test(candidate) ? scopes.get(candidate) : undefined;
    if (!scope) {
      log("warn", "git proxy request with an unknown handle");
      return refuse(req, res, 404, "pi-host git proxy: unknown handle");
    }
    const path = slash < 0 ? "/" : rawPath.slice(slash);
    const method = req.method ?? "GET";
    // No `.`/`..` segment, empty segment, escape, or separator that GitHub
    // could resolve to a different path than the one checked here.
    const segments = path.split("/").slice(1);
    if (!SAFE_PATH.test(path) || segments.some((segment) => segment === "." || segment === "..") || (query !== undefined && !SAFE_QUERY.test(query))) {
      log("warn", "git proxy refused a request path", { sessionId: scope.sessionId });
      return refuse(req, res, 400, "pi-host git proxy: unsupported request path");
    }
    const target = `${path}${query === undefined ? "" : `?${query}`}`;
    const repositoryPrefix = `/${scope.repository.owner}/${scope.repository.name}.git/`;
    const endpoint = path.startsWith(repositoryPrefix) ? credentialedEndpoint(method, path.slice(repositoryPrefix.length), query) : null;
    if (!endpoint) {
      // Another repository, or another path: as if there were no proxy.
      log("info", "git proxy request", { sessionId: scope.sessionId, method, endpoint: "anonymous" });
      return forward(req, res, target, null, null, scope.sessionId);
    }
    const token = tokens.get(scope.installationId);
    if (!token) {
      log("warn", "git proxy has no credential for the session", { sessionId: scope.sessionId, endpoint });
      return refuse(req, res, 401, "pi-host git proxy: no GitHub credential; the desktop that owns this session is not connected");
    }
    const authorization = `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
    if (endpoint !== "receive-pack") {
      log("info", "git proxy request", { sessionId: scope.sessionId, method, endpoint });
      return forward(req, res, target, authorization, null, scope.sessionId);
    }
    const inspection = await inspectReceivePack(req, scope.workBranch);
    if (!inspection.ok) {
      log("warn", "git proxy refused a push", { sessionId: scope.sessionId, reason: inspection.reason });
      return refuse(req, res, 403, `pi-host git proxy: ${inspection.reason}`);
    }
    // The scope may have been unregistered, or the token dropped, meanwhile.
    if (scopes.get(candidate) !== scope || tokens.get(scope.installationId) !== token) {
      return refuse(req, res, 401, "pi-host git proxy: no GitHub credential; the desktop that owns this session is not connected");
    }
    log("info", "git proxy request", { sessionId: scope.sessionId, method, endpoint });
    forward(req, res, target, authorization, inspection, scope.sessionId);
  };

  return {
    async start() {
      if (server) return;
      const created = createServer((req, res) => {
        handle(req, res).catch(() => {
          log("warn", "git proxy request failed");
          reply(res, 500, "pi-host git proxy: internal error");
        });
      });
      // A clone or push may run for an hour; git's own limits apply, not ours.
      created.requestTimeout = 0;
      created.timeout = 0;
      // Before any request is read: only a process of this user may talk to
      // the proxy. An owner that cannot be determined is refused.
      created.on("connection", (socket) => {
        if (!peerUid) return;
        const uid = socket.remotePort === undefined ? null : peerUid(socket.remotePort, port);
        if (uid !== null && uid === ownUid) return;
        log("warn", uid === null ? "git proxy closed a connection whose owner is unknown" : "git proxy closed a connection opened by another user", uid === null ? undefined : { uid });
        socket.destroy();
      });
      if (!peerUid) log("warn", "git proxy cannot check which user opens a connection on this platform; any local user who learns a handle can use it");
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(0, "127.0.0.1", () => {
          created.off("error", reject);
          resolve();
        });
      });
      server = created;
      port = (created.address() as AddressInfo).port;
    },
    async close() {
      const current = server;
      if (!current) return;
      server = null;
      tokens.clear();
      scopes.clear();
      handles.clear();
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections();
      });
    },
    setToken(installationId, token) {
      if (!token) return void tokens.delete(installationId);
      tokens.set(installationId, token);
      // A handle is readable by other local users (see the module comment),
      // so it does not outlive the credential set it was issued under.
      for (const [handleId, scope] of scopes) {
        if (scope.installationId !== installationId) continue;
        scopes.delete(handleId);
        handles.delete(scopeKey(scope.installationId, scope.sessionId));
      }
    },
    register(scope) {
      if (!server) throw new Error("the git credential proxy is not listening");
      const key = scopeKey(scope.installationId, scope.sessionId);
      let handleId = handles.get(key);
      if (!handleId) {
        handleId = randomBytes(32).toString("hex");
        handles.set(key, handleId);
      }
      const existing = scopes.get(handleId);
      if (existing && existing.repository.owner === scope.repository.owner
        && existing.repository.name === scope.repository.name && existing.workBranch === scope.workBranch) {
        return `http://127.0.0.1:${port}/${handleId}/`;
      }
      scopes.set(handleId, { installationId: scope.installationId, sessionId: scope.sessionId, repository: { owner: scope.repository.owner, name: scope.repository.name }, workBranch: scope.workBranch });
      return `http://127.0.0.1:${port}/${handleId}/`;
    },
    unauthorizedUrl() {
      return server ? `http://127.0.0.1:${port}/${unauthorizedHandle}/` : undefined;
    },
    unregister(installationId, sessionId) {
      const key = scopeKey(installationId, sessionId);
      const handleId = handles.get(key);
      if (!handleId) return;
      handles.delete(key);
      scopes.delete(handleId);
    },
  };
}
