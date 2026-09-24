/**
 * Backend router: the single seam that decides whether a renderer IPC call is
 * served by this desktop's local host-core (the default, byte-for-byte
 * unchanged) or forwarded to a paired remote `pi-host` over RACP-WS.
 *
 * The frozen architecture keeps this out of the per-domain IPC handlers and out
 * of the God-modules: `register.ts` consults `route()` from inside its `handle`
 * wrapper, and everything remote lives under `electron/main/remote/*`.
 *
 * Routing is decided by the session a call names, and it fails closed
 * (amending ADR 0286 §3): a call that names a `remote:` session never reaches a
 * local handler, because a local handler would read or write this desktop's own
 * data under a remote id. Such a call is served by its host's backend, refused
 * with `HOST_UNAVAILABLE` while that host is not connected, refused with
 * `CAPABILITY_UNAVAILABLE` for a channel the backend does not serve, or — only
 * for the audited {@link LOCAL_SAFE_CHANNELS} — run locally. A call that names
 * no remote session is always local.
 *
 * Renderer-visible session ids for remote sessions are namespaced
 * `remote:<hostKey>:<hostSessionId>`, mirroring the proven `native-pi:` prefix
 * (session-ipc.ts). The renderer never parses the prefix; it is resolved here.
 */
import { IPC } from "@pi-desktop/shared";

/** Sentinel telling the caller to run the existing local handler unchanged. */
export const ROUTE_LOCAL = Symbol("pi-desktop.route-local");

/** Namespaced-id prefix for sessions owned by a remote host. */
const REMOTE_PREFIX = "remote:";

/**
 * Delimiter that embeds the renderer-visible remote session id inside a tool
 * permission `requestId`. `toolResolvePermission` carries only `{requestId,
 * decision}` — no session id — so the id itself must name its owning session
 * for {@link sessionIdForCall} to route the resolution statelessly, with no
 * correlation map. Chosen so it cannot collide with a `remote:` session id or a
 * host-assigned approval id.
 */
const APPROVAL_ID_DELIMITER = "#racp-approval:";

/**
 * Delimiter that embeds the remote session id inside a queued-turn id, for the
 * same reason: queue remove and prioritize carry only `{ turnId }`.
 */
const QUEUED_TURN_ID_DELIMITER = "#racp-turn:";

/**
 * Channels that may carry a remote session id yet only touch desktop-owned
 * state, so they run the local handler. Each entry is audited: it must never
 * read or write host-core session data for the id it is given.
 */
export const LOCAL_SAFE_CHANNELS: ReadonlySet<string> = new Set([
  // Which session the window shows, for notification suppression.
  IPC.invoke.notificationSetViewingSession,
  // A native OS notification whose click target is the id.
  IPC.invoke.notificationShowNative,
  // Plugin views and the browser panel are keyed by the viewing session only.
  IPC.invoke.pluginViewOpen,
  IPC.invoke.pluginViewSetVisible,
  IPC.invoke.browserNavigate,
]);

/** A connected remote host, serving every session under its host key. */
export interface RemoteBackend {
  /** Whether this backend can serve `channel`; others fail closed. */
  handles(channel: string): boolean;
  /** Serve the call remotely, returning the value the renderer expects. */
  invoke(channel: string, args: readonly unknown[]): Promise<unknown>;
}

/** Result of {@link BackendRouter.route}: run locally, or a served remote value. */
export type RouteOutcome =
  | typeof ROUTE_LOCAL
  | { readonly remote: true; readonly value: unknown };

export interface BackendRouter {
  /** Bind every `remote:<hostKey>:…` id to the backend of that connected host. */
  registerHost(hostKey: string, backend: RemoteBackend): void;
  /**
   * Release a host. With `backend`, only that registration is released, so a
   * closing connection cannot drop the one that replaced it.
   */
  unregisterHost(hostKey: string, backend?: RemoteBackend): void;
  /** The backend registered for `hostKey`, or null. */
  backendForHost(hostKey: string): RemoteBackend | null;
  /** Route a renderer IPC call. */
  route(channel: string, args: readonly unknown[]): Promise<RouteOutcome>;
}

export type BackendRouterOptions = {
  /** Optional structured log for routing faults; defaults to a no-op. */
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

function routeError(code: string, message: string, retriable: boolean): Error {
  return Object.assign(new Error(message), {
    errorCode: code,
    data: { errorCode: code, retriable },
  });
}

/** Build the namespaced id the renderer sees for a remote session. */
export function makeRemoteSessionId(hostKey: string, hostSessionId: string): string {
  if (hostKey.includes(":")) {
    throw Object.assign(new Error("remote hostKey must not contain ':'"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  return `${REMOTE_PREFIX}${hostKey}:${hostSessionId}`;
}

export function isRemoteSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.startsWith(REMOTE_PREFIX);
}

/** Split a `remote:<hostKey>:<hostSessionId>` id back into its parts. */
export function parseRemoteSessionId(
  sessionId: string,
): { hostKey: string; hostSessionId: string } | null {
  if (!sessionId.startsWith(REMOTE_PREFIX)) return null;
  const rest = sessionId.slice(REMOTE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { hostKey: rest.slice(0, sep), hostSessionId: rest.slice(sep + 1) };
}

function decodeScoped(
  value: string,
  delimiter: string,
): { remoteSessionId: string; hostId: string } | null {
  const at = value.indexOf(delimiter);
  if (at <= 0) return null;
  const remoteSessionId = value.slice(0, at);
  if (!parseRemoteSessionId(remoteSessionId)) return null;
  const hostId = value.slice(at + delimiter.length);
  if (!hostId) return null;
  return { remoteSessionId, hostId };
}

/**
 * Encode a tool permission `requestId` that names its owning remote session.
 * The renderer echoes this id back verbatim in `toolResolvePermission`, and the
 * router recovers the session from it without any server-side correlation.
 */
export function makeRemoteApprovalRequestId(
  remoteSessionId: string,
  hostApprovalId: string,
): string {
  return `${remoteSessionId}${APPROVAL_ID_DELIMITER}${hostApprovalId}`;
}

/** Split an encoded approval `requestId`; null for a plain (local) id. */
export function parseRemoteApprovalRequestId(
  requestId: string,
): { remoteSessionId: string; hostApprovalId: string } | null {
  const parsed = decodeScoped(requestId, APPROVAL_ID_DELIMITER);
  return parsed && { remoteSessionId: parsed.remoteSessionId, hostApprovalId: parsed.hostId };
}

/** Encode a queued-turn id that names its owning remote session. */
export function makeRemoteQueuedTurnId(remoteSessionId: string, hostTurnId: string): string {
  return `${remoteSessionId}${QUEUED_TURN_ID_DELIMITER}${hostTurnId}`;
}

/** Split an encoded queued-turn id; null for a plain (local) id. */
export function parseRemoteQueuedTurnId(
  turnId: string,
): { remoteSessionId: string; hostTurnId: string } | null {
  const parsed = decodeScoped(turnId, QUEUED_TURN_ID_DELIMITER);
  return parsed && { remoteSessionId: parsed.remoteSessionId, hostTurnId: parsed.hostId };
}

/**
 * The remote session a renderer IPC call names, or null. Desktop channels pass
 * the session id as the first positional argument, as `sessionId` or `id` on
 * the first argument object, or encoded in an approval `requestId` or a
 * queued-turn `turnId`. Matching a bare `id` is safe because only a
 * `remote:`-prefixed value resolves, and no other entity id carries it.
 */
export function sessionIdForCall(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return isRemoteSessionId(first) ? first : null;
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  for (const key of ["sessionId", "id"] as const) {
    const value = record[key];
    if (isRemoteSessionId(value)) return value;
  }
  if (typeof record.requestId === "string") {
    const parsed = parseRemoteApprovalRequestId(record.requestId);
    if (parsed) return parsed.remoteSessionId;
  }
  if (typeof record.turnId === "string") {
    const parsed = parseRemoteQueuedTurnId(record.turnId);
    if (parsed) return parsed.remoteSessionId;
  }
  return null;
}

/**
 * Refuse a call that names a remote session. For invoke paths that bypass
 * {@link BackendRouter.route} (external agents, scheduled runs): they must not
 * reach a local handler with a remote id either.
 */
export function assertNotRemoteCall(args: readonly unknown[]): void {
  if (sessionIdForCall(args)) {
    throw routeError(
      "CAPABILITY_UNAVAILABLE",
      "remote sessions are not available on this invoke path",
      false,
    );
  }
}

/**
 * Give a RACP client error (`code`, `retriable`) the `errorCode` / `data`
 * shape the IPC `wrap` reads, so the renderer sees the host's code instead of
 * `INTERNAL`.
 */
export function normalizeRemoteError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const candidate = error as Error & { code?: unknown; retriable?: unknown; errorCode?: unknown };
  if (candidate.errorCode !== undefined) return error;
  if (typeof candidate.code !== "string" || typeof candidate.retriable !== "boolean") return error;
  return routeError(candidate.code, error.message, candidate.retriable);
}

export function createBackendRouter(options: BackendRouterOptions = {}): BackendRouter {
  const log = options.log ?? (() => undefined);
  const hostBackends = new Map<string, RemoteBackend>();

  return {
    registerHost(hostKey, backend) {
      hostBackends.set(hostKey, backend);
    },
    unregisterHost(hostKey, backend) {
      if (backend && hostBackends.get(hostKey) !== backend) return;
      hostBackends.delete(hostKey);
    },
    backendForHost(hostKey) {
      return hostBackends.get(hostKey) ?? null;
    },
    async route(channel, args) {
      const sessionId = sessionIdForCall(args);
      if (!sessionId) return ROUTE_LOCAL;
      if (LOCAL_SAFE_CHANNELS.has(channel)) return ROUTE_LOCAL;
      const parsed = parseRemoteSessionId(sessionId);
      const backend = parsed ? hostBackends.get(parsed.hostKey) : undefined;
      if (!backend) {
        throw routeError("HOST_UNAVAILABLE", "the remote host is not connected", true);
      }
      if (!backend.handles(channel)) {
        throw routeError(
          "CAPABILITY_UNAVAILABLE",
          `${channel} is not available for remote sessions`,
          false,
        );
      }
      try {
        return { remote: true, value: await backend.invoke(channel, args) };
      } catch (error) {
        log("warn", `remote route failed for ${channel}`, error);
        throw normalizeRemoteError(error);
      }
    },
  };
}
