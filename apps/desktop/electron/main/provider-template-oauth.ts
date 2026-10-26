import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  isProviderTemplateHttpsUrl, validateProviderTemplateOAuth,
  type PluginProviderOAuthCredential, type PluginProviderOAuthEvent,
  type PluginProviderOAuthRequest, type PluginProviderTemplateOAuthV1,
} from "@pi-desktop/plugin-sdk";

export type ProviderTemplateOAuthErrorCode =
  | "OAUTH_CONFIG" | "OAUTH_CANCELLED" | "OAUTH_TIMEOUT" | "OAUTH_NETWORK_TIMEOUT"
  | "OAUTH_NETWORK" | "OAUTH_HTTP" | "OAUTH_RESPONSE" | "OAUTH_CALLBACK"
  | "OAUTH_STATE" | "OAUTH_DENIED" | "OAUTH_EXPIRED" | "OAUTH_INVALID_GRANT";

/** Deliberately excludes server bodies, URLs, OAuth descriptions, causes and secrets. */
export class ProviderTemplateOAuthError extends Error {
  readonly code: ProviderTemplateOAuthErrorCode;
  constructor(code: ProviderTemplateOAuthErrorCode) {
    super(`Provider OAuth failed (${code})`);
    this.name = "ProviderTemplateOAuthError";
    this.code = code;
  }
}
const failure = (code: ProviderTemplateOAuthErrorCode): never => { throw new ProviderTemplateOAuthError(code); };

/** One trusted external boundary: production uses Electron's configured proxy and public-URL guard. */
export type ProviderTemplateOAuthNetwork = {
  assertUrl(url: string): Promise<void>;
  fetch(url: string, init: RequestInit): Promise<Response>;
};
export type ProviderTemplateOAuthCallback = {
  redirectUri: string;
  result: Promise<URL>;
  close(): void;
};
export type ProviderTemplateOAuthContext = {
  signal: AbortSignal;
  notify(event: PluginProviderOAuthEvent): void | Promise<void>;
  /** Only receives a policy-checked HTTPS authorization URL. */
  openExternal(url: string): void | Promise<void>;
  /** Optional trusted external I/O seams, not plugin-supplied capabilities. */
  network?: ProviderTemplateOAuthNetwork;
  createCallback?: (path: string, signal: AbortSignal, expectedState: string) => Promise<ProviderTemplateOAuthCallback>;
  /** Overall ceiling 10 minutes, default 5 minutes. */
  timeoutMs?: number;
  /** Per-request ceiling 30 seconds, includes policy resolution and body reading. */
  requestTimeoutMs?: number;
};

async function productionNetwork(): Promise<ProviderTemplateOAuthNetwork> {
  const [{ net, session }, { createPublicHttpsClient }, { relaxedNetworkPolicyEnabled }] = await Promise.all([
    import("electron"), import("./public-https-fetch"), import("./endpoint-policy"),
  ]);
  const guard = createPublicHttpsClient({
    fetchImpl: (url, init) => net.fetch(url, init),
    routeImpl: url => session.defaultSession.resolveProxy(url),
    allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  });
  return { assertUrl: url => guard.assertPublicUrl(url, "third-party"), fetch: (url, init) => net.fetch(url, init) };
}

/** Races even an external implementation that ignores its signal; always removes its listener. */
function abortable<T>(work: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderTemplateOAuthError("OAUTH_CANCELLED"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new ProviderTemplateOAuthError("OAUTH_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) return failure("OAUTH_CANCELLED");
      return work();
    }).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProviderTemplateOAuthError("OAUTH_CANCELLED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function secret(value: unknown, maxBytes = 16 * 1024): value is string {
  return typeof value === "string" && !!value.trim() && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value);
}
function seconds(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function timeout(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : failure("OAUTH_CONFIG");
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body || !/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return failure("OAUTH_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(() => reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) return failure("OAUTH_RESPONSE");
      chunks.push(value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return failure("OAUTH_RESPONSE"); }
    return object(parsed) ? parsed : failure("OAUTH_RESPONSE");
  } finally {
    // Cancellation failures are external cleanup noise, never credential-bearing diagnostics.
    void reader.cancel().then(() => reader.releaseLock()).catch(() => {});
  }
}

async function post(network: ProviderTemplateOAuthNetwork, url: string, body: URLSearchParams, signal: AbortSignal, requestMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
  if (!isProviderTemplateHttpsUrl(url)) return failure("OAUTH_CONFIG");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestMs);
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  let response: Response | undefined;
  try {
    await abortable(() => network.assertUrl(url), requestSignal);
    response = await abortable(async () => {
      const received = await network.fetch(url, {
        method: "POST", body: body.toString(), signal: requestSignal, redirect: "manual",
        credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      });
      if (requestSignal.aborted) {
        void received.body?.cancel().catch(() => {});
        return failure("OAUTH_CANCELLED");
      }
      return received;
    }, requestSignal);
    // Never follow a redirect carrying an authorization code or refresh/device token.
    if (![200, 400, 401].includes(response.status)) return failure("OAUTH_HTTP");
    return { status: response.status, data: await readJson(response, requestSignal) };
  } catch (error) {
    if (signal.aborted) return failure("OAUTH_CANCELLED");
    if (controller.signal.aborted) return failure("OAUTH_NETWORK_TIMEOUT");
    if (error instanceof ProviderTemplateOAuthError) throw error;
    return failure("OAUTH_NETWORK");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
function oauthError(data: Record<string, unknown>): never {
  if (data.error === "access_denied") return failure("OAUTH_DENIED");
  if (data.error === "expired_token") return failure("OAUTH_EXPIRED");
  if (data.error === "invalid_grant") return failure("OAUTH_INVALID_GRANT");
  return failure("OAUTH_RESPONSE");
}
function credential(status: number, data: Record<string, unknown>): PluginProviderOAuthCredential {
  if (status !== 200) return oauthError(data);
  if (data.error !== undefined || !secret(data.access_token) || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") return failure("OAUTH_RESPONSE");
  const result: PluginProviderOAuthCredential = { accessToken: data.access_token };
  if (data.refresh_token !== undefined) {
    if (!secret(data.refresh_token)) return failure("OAUTH_RESPONSE");
    result.refreshToken = data.refresh_token;
  }
  if (data.expires_in !== undefined) {
    if (!seconds(data.expires_in, 10 * 365 * 86400)) return failure("OAUTH_RESPONSE");
    result.expiresAt = Date.now() + data.expires_in * 1000;
  }
  // No JWT decoding, arbitrary headers, routing metadata or server-supplied account labels.
  return result;
}

/** Shared by the listener and the post-I/O check, so invalid requests cannot settle a login. */
function callbackQuery(values: URLSearchParams, expectedState: string): { code: string } | { error: string } {
  if (values.getAll("state").length !== 1) return failure("OAUTH_STATE");
  const actual = Buffer.from(values.get("state") ?? "");
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure("OAUTH_STATE");
  if (values.has("error")) {
    const error = values.get("error");
    if (values.getAll("error").length !== 1 || values.has("code") || !secret(error, 256)) return failure("OAUTH_CALLBACK");
    return { error };
  }
  const code = values.get("code");
  if (values.getAll("code").length !== 1 || !secret(code, 4096)) return failure("OAUTH_CALLBACK");
  return { code };
}

/** Binds only IPv4 loopback on a fresh OS-assigned port and owns all associated sockets. */
export async function createProviderTemplateOAuthCallback(path: string, signal: AbortSignal, expectedState: string): Promise<ProviderTemplateOAuthCallback> {
  if (path.length > 256 || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.startsWith("//") || !secret(expectedState, 128)) return failure("OAUTH_CONFIG");
  let resolve!: (url: URL) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<URL>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => {});
  let redirectUri = "";
  let settled = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const raw = request.url ?? "";
      const url = new URL(raw, redirectUri);
      if (settled || request.method !== "GET" || raw.length > 8192 || !raw.startsWith("/") || raw.startsWith("//") || url.origin !== new URL(redirectUri).origin || request.headers.host !== new URL(redirectUri).host || url.pathname !== path || url.hash) {
        response.writeHead(404).end("Not found."); return;
      }
      callbackQuery(url.searchParams, expectedState);
      settled = true;
      response.writeHead(200).end("You may close this window.");
      resolve(url);
    } catch {
      response.writeHead(400).end("Invalid callback.");
    }
  });
  server.maxConnections = 8;
  server.keepAliveTimeout = 1000;
  const close = () => { signal.removeEventListener("abort", abort); server.close(); server.closeAllConnections(); };
  const abort = () => { reject(new ProviderTemplateOAuthError("OAUTH_CANCELLED")); close(); };
  server.on("error", () => reject(new ProviderTemplateOAuthError("OAUTH_CALLBACK")));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await abortable(() => new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen({ port: 0, host: "127.0.0.1", signal }, () => { server.removeListener("error", no); yes(); });
    }), signal);
    const address = server.address();
    if (!address || typeof address === "string") return failure("OAUTH_CALLBACK");
    redirectUri = `http://127.0.0.1:${address.port}${path}`;
    return { redirectUri, result, close };
  } catch { close(); return failure(signal.aborted ? "OAUTH_CANCELLED" : "OAUTH_CALLBACK"); }
}

async function authorizationCode(config: PluginProviderTemplateOAuthV1, network: ProviderTemplateOAuthNetwork, context: ProviderTemplateOAuthContext, signal: AbortSignal, requestMs: number): Promise<PluginProviderOAuthCredential> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = await abortable(async () => {
    const opened = await (context.createCallback ?? createProviderTemplateOAuthCallback)(config.redirectPath ?? "/callback", signal, state);
    if (signal.aborted) { opened.close(); return failure("OAUTH_CANCELLED"); }
    return opened;
  }, signal);
  void callback.result.catch(() => {});
  try {
    const redirect = new URL(callback.redirectUri);
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port || redirect.pathname !== (config.redirectPath ?? "/callback") || redirect.search || redirect.hash || redirect.username || redirect.password) return failure("OAUTH_CALLBACK");
    const url = new URL(config.authorizationUrl!);
    // Replace reserved parameters, including duplicates in a declared URL.
    for (const key of ["code", "code_verifier", "client_secret", "scope"]) url.searchParams.delete(key);
    const params = { client_id: config.clientId!, response_type: "code", redirect_uri: callback.redirectUri, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (config.scopes?.length) url.searchParams.set("scope", config.scopes.join(" "));
    await abortable(() => network.assertUrl(url.toString()), signal);
    await abortable(() => context.openExternal(url.toString()), signal);
    const returned = await abortable(() => callback.result, signal);
    if (returned.origin !== redirect.origin || returned.pathname !== redirect.pathname || returned.hash) return failure("OAUTH_CALLBACK");
    const query = callbackQuery(returned.searchParams, state);
    if ("error" in query) return oauthError(query);
    const { code } = query;
    const { status, data } = await post(network, config.tokenUrl!, new URLSearchParams({
      grant_type: "authorization_code", client_id: config.clientId!, redirect_uri: callback.redirectUri, code, code_verifier: verifier,
    }), signal, requestMs);
    return credential(status, data);
  } finally { callback.close(); }
}

async function deviceCode(config: PluginProviderTemplateOAuthV1, network: ProviderTemplateOAuthNetwork, context: ProviderTemplateOAuthContext, signal: AbortSignal, requestMs: number): Promise<PluginProviderOAuthCredential> {
  const form = new URLSearchParams({ client_id: config.clientId! });
  if (config.scopes?.length) form.set("scope", config.scopes.join(" "));
  const initial = await post(network, config.deviceAuthorizationUrl!, form, signal, requestMs);
  if (initial.status !== 200) return oauthError(initial.data);
  const data = initial.data;
  if (data.error !== undefined || !secret(data.device_code) || !secret(data.user_code, 256) || !isProviderTemplateHttpsUrl(data.verification_uri) || !seconds(data.expires_in, 86400) || (data.interval !== undefined && !seconds(data.interval, 3600))) return failure("OAUTH_RESPONSE");
  let interval = typeof data.interval === "number" ? data.interval : 5;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), data.expires_in * 1000);
  const deviceSignal = AbortSignal.any([signal, controller.signal]);
  try {
    await abortable(() => network.assertUrl(data.verification_uri as string), deviceSignal);
    await abortable(() => context.notify({ kind: "deviceCode", userCode: data.user_code as string, verificationUri: data.verification_uri as string, intervalSeconds: interval, expiresInSeconds: data.expires_in as number }), deviceSignal);
    while (true) {
      await delay(interval * 1000, deviceSignal);
      let response;
      try {
        response = await post(network, config.tokenUrl!, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: config.clientId!, device_code: data.device_code as string }), deviceSignal, requestMs);
      } catch (error) {
        // RFC 8628: reduce polling frequency after a connection timeout.
        if (error instanceof ProviderTemplateOAuthError && error.code === "OAUTH_NETWORK_TIMEOUT") { interval = Math.min(interval * 2, 3600); continue; }
        throw error;
      }
      if (response.status === 400 && response.data.error === "authorization_pending") continue;
      if (response.status === 400 && response.data.error === "slow_down") { interval += 5; continue; }
      return credential(response.status, response.data);
    }
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) return failure("OAUTH_EXPIRED");
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}

/**
 * Execute only validated public-client declarative flows. Host owns permission checks,
 * account identity, encrypted persistence and refresh serialization. Omitted refreshToken
 * intentionally leaves rotation/preservation to the existing Host credential store.
 */
export async function runProviderTemplateOAuth(config: PluginProviderTemplateOAuthV1, request: PluginProviderOAuthRequest, context: ProviderTemplateOAuthContext): Promise<PluginProviderOAuthCredential> {
  if (validateProviderTemplateOAuth(config) || !["authorization_code", "device_code"].includes(config.flow ?? "custom") || !["login", "refresh"].includes(request.operation)) return failure("OAUTH_CONFIG");
  config = { ...config, ...(config.scopes ? { scopes: [...config.scopes] } : {}) };
  const overallMs = timeout(context.timeoutMs, 300_000, 600_000);
  const requestMs = timeout(context.requestTimeoutMs, 30_000, 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), overallMs);
  const signal = AbortSignal.any([context.signal, controller.signal]);
  try {
    const network = context.network ?? await abortable(productionNetwork, signal);
    if (request.operation === "refresh") {
      const refreshToken = request.credential?.refreshToken;
      if (!secret(refreshToken)) return failure("OAUTH_INVALID_GRANT");
      const { status, data } = await post(network, config.tokenUrl!, new URLSearchParams({ grant_type: "refresh_token", client_id: config.clientId!, refresh_token: refreshToken }), signal, requestMs);
      return credential(status, data);
    }
    return await (config.flow === "authorization_code" ? authorizationCode : deviceCode)(config, network, context, signal, requestMs);
  } catch (error) {
    if (context.signal.aborted) return failure("OAUTH_CANCELLED");
    if (controller.signal.aborted) return failure("OAUTH_TIMEOUT");
    if (error instanceof ProviderTemplateOAuthError) throw error;
    return failure("OAUTH_NETWORK");
  } finally { clearTimeout(timer); controller.abort(); }
}
