import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  isUserSuppliedHostname,
  type McpOAuthLoginEvent,
  type McpServerRecord,
  type McpServerStatus,
} from "@pi-desktop/shared";
import { allowInsecureUserEndpointsEnabled } from "./endpoint-policy.ts";
export type StoredMcpOAuthToken = {
  clientId: string;
  clientSecret?: string;
  registrationEndpoint?: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  resource?: string;
  redirectUris?: string[];
};

export type McpOAuthMetadata = {
  resource: string;
  authorizationServers: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

export type McpOAuthDeps = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  openExternal: (url: string) => Promise<void>;
  emit?: (event: McpOAuthLoginEvent) => void;
  fetchImpl?: typeof fetch;
  createServer?: typeof createServer;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  onAuthorized?: (serverId: string, record?: McpServerRecord) => Promise<McpServerStatus>;
  newId?: () => string;
};

export function secretRefForMcpOAuth(serverId: string): string {
  return `secret:mcp:${serverId}:oauth`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseExpiresIn(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** RFC 8252 loopback redirect without a port, so the AS may accept any ephemeral port. */
export const LOOPBACK_REDIRECT_PORTLESS = "http://127.0.0.1/callback";

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * OAuth 2.1: authorization-server endpoints must be HTTPS, except on a host the
 * user runs themselves.
 *
 * Loopback over plain `http` is the RFC 8252 shape and always passes. Any other
 * plaintext URL passes only when the user has enabled insecure user endpoints in
 * settings **and** it names the same host as the MCP server they typed
 * (`trustedUrl`). Every other URL this guard sees arrives inside server metadata
 * — `WWW-Authenticate`, a protected-resource or authorization-server document —
 * so a server must not be able to send the app to a plaintext internal address
 * the user never entered. `https` needs no such anchor.
 *
 * The refusal names both ways out: switch to HTTPS, or accept plaintext in
 * settings.
 */
export function assertTlsProtectedUrl(raw: string, label: string, trustedUrl?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) return url;
    if (
      allowInsecureUserEndpointsEnabled() &&
      trustedUrl !== undefined &&
      isUserSuppliedHostname(url.hostname) &&
      sameHostname(trustedUrl, url.hostname)
    ) {
      return url;
    }
    throw new Error(
      `${label} must use HTTPS (got ${url.protocol}//${url.host}); use HTTPS or enable plaintext endpoints for hosts you entered yourself in settings`,
    );
  }
  throw new Error(`${label} must use HTTPS (got ${url.protocol}//${url.host})`);
}

/** Host equality for a URL or a bare host, ignoring brackets, case and a dot. */
function sameHostname(left: string, right: string): boolean {
  const host = (value: string): string => {
    const bare = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    try {
      return new URL(value).hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    } catch {
      return bare;
    }
  };
  const target = host(left);
  return target !== "" && target === host(right);
}

export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function canReuseDcrClient(
  token: StoredMcpOAuthToken | null | undefined,
  registrationEndpoint: string | undefined,
  exactRedirect: string,
): boolean {
  if (!token?.clientId) return false;
  if (token.registrationEndpoint !== registrationEndpoint) return false;
  const uris = token.redirectUris ?? [];
  return uris.includes(LOOPBACK_REDIRECT_PORTLESS) || uris.includes(exactRedirect);
}

export function preferredLoopbackPort(uris: string[] | undefined): number | undefined {
  for (const uri of uris ?? []) {
    try {
      const url = new URL(uri);
      if (url.hostname !== "127.0.0.1" || !url.port) continue;
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch {
      continue;
    }
  }
  return undefined;
}

type LoginSession = {
  loginId: string;
  serverId: string;
  serverUrl: string;
  record?: McpServerRecord;
  controller: AbortController;
  server?: Server;
  cleanup: () => void;
  finished: Promise<void>;
  tokenPromise: Promise<StoredMcpOAuthToken>;
  cancelled?: boolean;
};

const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class McpOAuthManager {
  private deps: McpOAuthDeps;
  private pendingLogins = new Map<string, LoginSession>();
  private readonly refreshChains = new Map<string, Promise<unknown>>();

  constructor(deps: McpOAuthDeps) {
    this.deps = deps;
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch;
  }

  private get createServer(): typeof createServer {
    return this.deps.createServer ?? createServer;
  }

  private nextId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  private emit(event: McpOAuthLoginEvent): void {
    this.deps.emit?.(event);
  }

  /**
   * Discover OAuth metadata from an MCP server URL per RFC 9728 & RFC 8414.
   * All discovery requests use `redirect: "manual"` (ADR 0142).
   */
  async discoverMetadata(serverUrl: string): Promise<McpOAuthMetadata> {
    const urlObj = new URL(serverUrl);
    let resourceMetadataUrl: string | undefined;

    // Step 1: Probe endpoint to check for 401 with WWW-Authenticate
    try {
      const probeRes = await this.fetch(serverUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe",
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "PI-Desktop", version: "1" },
          },
        }),
      });
      if (probeRes.status === 401) {
        const wwwAuth = probeRes.headers.get("www-authenticate");
        if (wwwAuth) {
          const match =
            wwwAuth.match(/resource_metadata="([^"]+)"/i) ??
            wwwAuth.match(/resource_metadata=([^,\s]+)/i);
          if (match?.[1]) {
            resourceMetadataUrl = match[1];
          }
        }
      }
    } catch {
      // Best-effort probe; fallback to standard paths below.
    }
    if (resourceMetadataUrl) {
      assertTlsProtectedUrl(resourceMetadataUrl, "resource_metadata", serverUrl);
    }

    // Step 2: Fallback to standard RFC 9728 paths if not in WWW-Authenticate
    let prm: Record<string, unknown> | null = null;
    const candidateUrls: string[] = [];
    if (resourceMetadataUrl) {
      candidateUrls.push(resourceMetadataUrl);
    }
    const pathSuffix = urlObj.pathname.replace(/\/+$/, "");
    if (pathSuffix && pathSuffix !== "/") {
      candidateUrls.push(
        new URL(`/.well-known/oauth-protected-resource${pathSuffix}`, urlObj.origin).toString(),
      );
    }
    candidateUrls.push(
      new URL("/.well-known/oauth-protected-resource", urlObj.origin).toString(),
    );

    for (const prmUrl of candidateUrls) {
      try {
        const res = await this.fetch(prmUrl, { redirect: "manual" });
        if (res.ok) {
          prm = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        continue;
      }
    }

    const authServersRaw = Array.isArray(prm?.authorization_servers)
      ? (prm.authorization_servers as string[])
      : [];
    const authServer = authServersRaw[0] ?? urlObj.origin;
    assertTlsProtectedUrl(authServer, "authorization_server", serverUrl);
    const authServerObj = new URL(authServer);

    // Step 3: Fetch Authorization Server Metadata (RFC 8414)
    let asMeta: Record<string, unknown> | null = null;
    const asMetaCandidates = [
      new URL("/.well-known/oauth-authorization-server", authServerObj.origin).toString(),
      new URL("/.well-known/openid-configuration", authServerObj.origin).toString(),
    ];

    for (const asUrl of asMetaCandidates) {
      try {
        const res = await this.fetch(asUrl, { redirect: "manual" });
        if (res.ok) {
          asMeta = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        continue;
      }
    }

    const authorizationEndpoint =
      typeof asMeta?.authorization_endpoint === "string" ? asMeta.authorization_endpoint : "";
    const tokenEndpoint =
      typeof asMeta?.token_endpoint === "string" ? asMeta.token_endpoint : "";
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error(
        `MCP OAuth metadata discovery failed: authorization_endpoint or token_endpoint missing for ${serverUrl}`,
      );
    }

    assertTlsProtectedUrl(authorizationEndpoint, "authorization_endpoint", serverUrl);
    assertTlsProtectedUrl(tokenEndpoint, "token_endpoint", serverUrl);
    const registrationEndpoint =
      typeof asMeta?.registration_endpoint === "string" ? asMeta.registration_endpoint : undefined;
    if (registrationEndpoint) {
      assertTlsProtectedUrl(registrationEndpoint, "registration_endpoint", serverUrl);
    }
    const scopesSupported = Array.isArray(asMeta?.scopes_supported)
      ? (asMeta.scopes_supported as string[])
      : Array.isArray(prm?.scopes_supported)
        ? (prm.scopes_supported as string[])
        : undefined;

    return {
      resource: typeof prm?.resource === "string" ? prm.resource : serverUrl,
      authorizationServers: authServersRaw.length > 0 ? authServersRaw : [authServer],
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      scopesSupported,
    };
  }

  /**
   * Dynamic Client Registration (RFC 7591) with manual redirect.
   */
  async registerClient(
    registrationEndpoint: string,
    redirectUris: string | string[],
    trustedUrl?: string,
    clientName = "PI-Desktop",
  ): Promise<{ clientId: string; clientSecret?: string }> {
    assertTlsProtectedUrl(registrationEndpoint, "registration_endpoint", trustedUrl);
    const uris = Array.isArray(redirectUris) ? redirectUris : [redirectUris];
    const res = await this.fetch(registrationEndpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.deps.log?.("warn", "mcp oauth DCR failed", {
        status: res.status,
        body: text.slice(0, 300),
      });
      throw new Error(`Dynamic client registration failed (HTTP ${res.status})`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const clientId = typeof json.client_id === "string" ? json.client_id : "";
    if (!clientId) {
      throw new Error("Dynamic client registration response missing client_id");
    }
    const clientSecret = typeof json.client_secret === "string" ? json.client_secret : undefined;
    return { clientId, clientSecret };
  }

  private async registerLoopbackClient(
    registrationEndpoint: string,
    exactRedirect: string,
    trustedUrl: string,
  ): Promise<{ clientId: string; clientSecret?: string; redirectUris: string[] }> {
    const portless = [LOOPBACK_REDIRECT_PORTLESS, exactRedirect];
    try {
      const registered = await this.registerClient(registrationEndpoint, portless, trustedUrl);
      return { ...registered, redirectUris: portless };
    } catch (error) {
      this.deps.log?.("info", "mcp oauth portless DCR rejected, registering exact redirect", {
        message: error instanceof Error ? error.message : String(error),
      });
      const registered = await this.registerClient(
        registrationEndpoint,
        [exactRedirect],
        trustedUrl,
      );
      return { ...registered, redirectUris: [exactRedirect] };
    }
  }

  /**
   * Non-blocking start for MCP OAuth login.
   * Cancels any in-flight attempt for the same server, returns { ok: true, loginId }
   * immediately, and drives the browser login and loopback callback in the background.
   */
  async start(
    serverId: string,
    serverUrl: string,
    record?: McpServerRecord,
  ): Promise<{ ok: boolean; loginId: string }> {
    const existing = [...this.pendingLogins.values()].find((s) => s.serverId === serverId);
    if (existing) {
      this.cancel(existing.loginId);
      await existing.finished.catch(() => undefined);
    }

    const loginId = this.nextId();
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];

    let resolveToken!: (token: StoredMcpOAuthToken) => void;
    let rejectToken!: (err: Error) => void;
    const tokenPromise = new Promise<StoredMcpOAuthToken>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });
    tokenPromise.catch(() => undefined);

    const session: LoginSession = {
      loginId,
      serverId,
      serverUrl,
      record,
      controller,
      cleanup: () => {
        for (const fn of cleanups) {
          try {
            fn();
          } catch {
            // Best effort
          }
        }
      },
      tokenPromise,
      finished: Promise.resolve(),
    };

    cleanups.push(() => {
      this.pendingLogins.delete(loginId);
    });

    this.pendingLogins.set(loginId, session);
    session.finished = this.run(session, resolveToken, rejectToken, cleanups);

    return { ok: true, loginId };
  }

  /**
   * Convenience wrapper that starts login and awaits the resulting token.
   */
  async startLogin(serverId: string, serverUrl: string): Promise<StoredMcpOAuthToken> {
    const { loginId } = await this.start(serverId, serverUrl);
    const session = this.pendingLogins.get(loginId);
    if (!session) throw new Error("OAuth session not found");
    return session.tokenPromise;
  }

  /**
   * Run the OAuth login session in the background.
   */
  private async run(
    session: LoginSession,
    resolveToken: (token: StoredMcpOAuthToken) => void,
    rejectToken: (err: Error) => void,
    cleanups: Array<() => void>,
  ): Promise<void> {
    try {
      this.emit({ loginId: session.loginId, serverId: session.serverId, kind: "progress", message: "Discovering metadata…" });
      const metadata = await this.discoverMetadata(session.serverUrl);

      if (session.controller.signal.aborted) {
        throw new Error("OAuth login cancelled");
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const expectedState = randomBytes(16).toString("hex");
        let clientId = "";
        let clientSecret: string | undefined;
        let redirectUri = "";
        let redirectUrisToStore: string[] | undefined;

        const finish = (error?: Error, token?: StoredMcpOAuthToken) => {
          if (settled) return;
          settled = true;
          if (error) {
            rejectToken(error);
            reject(error);
            return;
          }
          if (token) {
            resolveToken(token);
            resolve();
          }
        };

        const server = this.createServer(async (req, res) => {
          try {
            const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
            if (reqUrl.pathname !== "/callback") {
              res.writeHead(404, { "content-type": "text/plain" });
              res.end("Not Found");
              return;
            }

            if (settled) {
              res.writeHead(409, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, "Authorization already completed"));
              return;
            }

            if (!expectedState || !redirectUri || !clientId) {
              res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, "Authorization is not ready"));
              return;
            }

            const state = reqUrl.searchParams.get("state");
            const code = reqUrl.searchParams.get("code");
            const error = reqUrl.searchParams.get("error");
            const errorDescription = reqUrl.searchParams.get("error_description");

            // CSRF: unmatched state is a stray request — do not abort the login.
            if (state !== expectedState) {
              res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, "Invalid OAuth callback state"));
              return;
            }

            settled = true;

            if (error) {
              const displayErr = errorDescription ? `${error}: ${errorDescription}` : error;
              res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, `Authorization error: ${displayErr}`));
              const err = new Error(`OAuth authorization error: ${displayErr}`);
              rejectToken(err);
              reject(err);
              return;
            }

            if (!code) {
              res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, "Invalid OAuth callback: missing code"));
              const err = new Error("Invalid OAuth callback: missing code");
              rejectToken(err);
              reject(err);
              return;
            }

            const tokenParams = new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
              resource: metadata.resource,
            });
            if (clientSecret) {
              tokenParams.set("client_secret", clientSecret);
            }

            const tokenRes = await this.fetch(metadata.tokenEndpoint, {
              method: "POST",
              redirect: "manual",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
              },
              body: tokenParams.toString(),
            });

            if (!tokenRes.ok) {
              const errText = await tokenRes.text().catch(() => "");
              this.deps.log?.("warn", "mcp oauth token exchange failed", {
                status: tokenRes.status,
                body: errText.slice(0, 300),
              });
              res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, `Token exchange failed (${tokenRes.status})`));
              const err = new Error(`OAuth token exchange failed (HTTP ${tokenRes.status})`);
              rejectToken(err);
              reject(err);
              return;
            }

            const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
            const accessToken =
              typeof tokenJson.access_token === "string" ? tokenJson.access_token : "";
            if (!accessToken) {
              res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
              res.end(this.renderHtml(false, "Token response missing access_token"));
              const err = new Error("Token response missing access_token");
              rejectToken(err);
              reject(err);
              return;
            }

            const refreshToken =
              typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : undefined;
            const expiresIn = parseExpiresIn(tokenJson.expires_in);
            const storedToken: StoredMcpOAuthToken = {
              clientId,
              clientSecret,
              registrationEndpoint: metadata.registrationEndpoint,
              tokenEndpoint: metadata.tokenEndpoint,
              accessToken,
              refreshToken,
              expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
              scope: typeof tokenJson.scope === "string" ? tokenJson.scope : undefined,
              resource: metadata.resource,
              redirectUris: redirectUrisToStore,
            };

            await this.deps.call("secrets.set", {
              secretRef: secretRefForMcpOAuth(session.serverId),
              value: JSON.stringify(storedToken),
            });

            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(
              this.renderHtml(
                true,
                "Authorization successful! You can close this tab and return to PI-Desktop.",
              ),
            );

            resolveToken(storedToken);
            resolve();
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (!settled) {
              settled = true;
              rejectToken(error);
              reject(error);
            }
          }
        });

        session.server = server;
        cleanups.push(() => {
          server.close();
        });

        const abortListener = () => {
          finish(new Error("OAuth login cancelled"));
        };
        session.controller.signal.addEventListener("abort", abortListener, { once: true });
        cleanups.push(() =>
          session.controller.signal.removeEventListener("abort", abortListener),
        );

        const timeoutTimer = setTimeout(() => {
          finish(new Error("OAuth authorization timed out"));
        }, DEFAULT_AUTH_TIMEOUT_MS);
        cleanups.push(() => clearTimeout(timeoutTimer));

        void (async () => {
          try {
            const existingRaw = await this.readStoredToken(session.serverId);
            const preferredPort = preferredLoopbackPort(existingRaw?.redirectUris);
            const address = await this.listenOnLoopback(server, preferredPort);
            server.on("error", (err) => {
              finish(err instanceof Error ? err : new Error(String(err)));
            });
            redirectUri = loopbackRedirectUri(address.port);

            if (canReuseDcrClient(existingRaw, metadata.registrationEndpoint, redirectUri)) {
              clientId = existingRaw!.clientId;
              clientSecret = existingRaw!.clientSecret;
              redirectUrisToStore = existingRaw!.redirectUris;
            } else if (metadata.registrationEndpoint) {
              const registered = await this.registerLoopbackClient(
                metadata.registrationEndpoint,
                redirectUri,
                session.serverUrl,
              );
              clientId = registered.clientId;
              clientSecret = registered.clientSecret;
              redirectUrisToStore = registered.redirectUris;
            } else {
              clientId = "pi-desktop";
            }

            const authUrl = new URL(metadata.authorizationEndpoint);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", clientId);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("state", expectedState);
            authUrl.searchParams.set("code_challenge", codeChallenge);
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("resource", metadata.resource);

            // MVP: no per-server scope picker. Prefer a literal "default" if
            // advertised (Notion-class), otherwise the first supported scope.
            if (metadata.scopesSupported?.includes("default")) {
              authUrl.searchParams.set("scope", "default");
            } else if (metadata.scopesSupported?.[0]) {
              authUrl.searchParams.set("scope", metadata.scopesSupported[0]);
            }

            this.deps.log?.("info", "opening browser for mcp oauth", {
              serverId: session.serverId,
              authUrl: authUrl.toString(),
            });

            const opened = await this.deps.openExternal(authUrl.toString()).then(
              () => true,
              () => false,
            );

            this.emit({
              loginId: session.loginId,
              serverId: session.serverId,
              kind: "authUrl",
              url: authUrl.toString(),
              opened,
            });
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });

      // Hook for post-auth runtime updates (re-testing server and refreshing status)
      let status: McpServerStatus | undefined;
      if (this.deps.onAuthorized) {
        try {
          status = await this.deps.onAuthorized(session.serverId, session.record);
        } catch {
          // Status will fallback to default below
        }
      }

      this.emit({
        loginId: session.loginId,
        serverId: session.serverId,
        kind: "done",
        status: status
          ? { ...status, hasOauth: true }
          : {
              serverId: session.serverId,
              state: "ready",
              toolCount: 0,
              updatedAt: Date.now(),
              hasOauth: true,
              authRequired: false,
            },
      });
    } catch (error) {
      if (session.controller.signal.aborted) {
        if (!session.cancelled) {
          session.cancelled = true;
          this.emit({
            loginId: session.loginId,
            serverId: session.serverId,
            kind: "cancelled",
          });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.("warn", "mcp oauth login failed", {
          serverId: session.serverId,
          message,
        });
        this.emit({
          loginId: session.loginId,
          serverId: session.serverId,
          kind: "error",
          message,
        });
      }
    } finally {
      session.cleanup();
    }
  }

  /**
   * Get a valid access token for the given MCP server, automatically refreshing if expired.
   * Serialized per serverId so rotating refresh tokens never race.
   */
  async getValidAccessToken(serverId: string): Promise<string | null> {
    return this.serialize(serverId, async () => {
      const token = await this.readStoredToken(serverId);
      if (!token) return null;

      if (token.expiresAt && Date.now() > token.expiresAt - 60_000 && token.refreshToken) {
        try {
          const refreshed = await this.refreshToken(serverId, token);
          return refreshed.accessToken;
        } catch (err) {
          this.deps.log?.("warn", "failed to refresh mcp oauth token", {
            serverId,
            error: (err as Error).message,
          });
          const still = await this.readStoredToken(serverId);
          if (!still) return null;
          return still.accessToken;
        }
      }

      return token.accessToken;
    });
  }

  async hasOAuth(serverId: string): Promise<boolean> {
    try {
      const res = await this.deps.call<{ has: boolean }>("secrets.has", {
        secretRef: secretRefForMcpOAuth(serverId),
      });
      return res?.has === true;
    } catch {
      return false;
    }
  }

  async deleteOAuth(serverId: string): Promise<void> {
    this.cancel(serverId);
    try {
      await this.deps.call("secrets.delete", {
        secretRef: secretRefForMcpOAuth(serverId),
      });
    } catch {
      // Best effort cleanup
    }
  }

  /**
   * Move the OAuth secret when an MCP server is renamed/transferred between levels.
   */
  async transferOAuth(oldServerId: string, newServerId: string): Promise<void> {
    if (!oldServerId || !newServerId || oldServerId === newServerId) return;
    const current = await this.readStoredToken(oldServerId);
    if (current) {
      await this.deps.call("secrets.set", {
        secretRef: secretRefForMcpOAuth(newServerId),
        value: JSON.stringify(current),
      });
      await this.deps.call("secrets.delete", {
        secretRef: secretRefForMcpOAuth(oldServerId),
      });
    }
  }

  cancel(loginIdOrServerId: string): boolean {
    const session =
      this.pendingLogins.get(loginIdOrServerId) ??
      [...this.pendingLogins.values()].find((s) => s.serverId === loginIdOrServerId);
    if (!session) return false;
    if (!session.cancelled) {
      session.cancelled = true;
      this.emit({
        loginId: session.loginId,
        serverId: session.serverId,
        kind: "cancelled",
      });
    }
    session.controller.abort();
    session.cleanup();
    return true;
  }

  disposeAll(): void {
    for (const session of this.pendingLogins.values()) {
      session.controller.abort();
      session.cleanup();
    }
    this.pendingLogins.clear();
  }

  private async readStoredToken(serverId: string): Promise<StoredMcpOAuthToken | null> {
    let raw: string | null = null;
    try {
      const res = await this.deps.call<{ value: string | null }>("secrets.getForRuntime", {
        secretRef: secretRefForMcpOAuth(serverId),
      });
      raw = res?.value ?? null;
    } catch {
      return null;
    }

    if (!raw) return null;

    try {
      return JSON.parse(raw) as StoredMcpOAuthToken;
    } catch {
      return null;
    }
  }

  private async refreshToken(
    serverId: string,
    token: StoredMcpOAuthToken,
  ): Promise<StoredMcpOAuthToken> {
    if (!token.refreshToken) {
      throw new Error("Token refresh failed: missing refresh_token");
    }
    assertTlsProtectedUrl(token.tokenEndpoint, "token_endpoint", token.resource);
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: token.clientId,
      refresh_token: token.refreshToken,
    });
    if (token.clientSecret) {
      params.set("client_secret", token.clientSecret);
    }
    if (token.resource) {
      params.set("resource", token.resource);
    }

    const res = await this.fetch(token.tokenEndpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.deps.log?.("warn", "mcp oauth token refresh failed", {
        serverId,
        status: res.status,
        body: text.slice(0, 300),
      });
      if (res.status === 400 || res.status === 401) {
        await this.clearStoredToken(serverId);
      }
      throw new Error(`Token refresh failed (HTTP ${res.status})`);
      throw new Error(`Token refresh failed (HTTP ${res.status})`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) {
      throw new Error("Refresh token response missing access_token");
    }

    const refreshToken =
      typeof json.refresh_token === "string" ? json.refresh_token : token.refreshToken;
    const expiresIn = parseExpiresIn(json.expires_in);

    const updated: StoredMcpOAuthToken = {
      ...token,
      accessToken,
      refreshToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      scope: typeof json.scope === "string" ? json.scope : token.scope,
    };

    await this.deps.call("secrets.set", {
      secretRef: secretRefForMcpOAuth(serverId),
      value: JSON.stringify(updated),
    });

    return updated;
  }
  private async clearStoredToken(serverId: string): Promise<void> {
    try {
      await this.deps.call("secrets.delete", {
        secretRef: secretRefForMcpOAuth(serverId),
      });
    } catch {
      // Best effort
    }
  }

  private listenOnLoopback(server: Server, preferredPort?: number): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const tryListen = (port: number, allowFallback: boolean) => {
        const onError = (err: Error) => {
          server.off("error", onError);
          if (allowFallback && (err as { code?: string }).code === "EADDRINUSE") {
            tryListen(0, false);
            return;
          }
          reject(err);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("OAuth loopback server has no address"));
            return;
          }
          resolve(address);
        });
      };
      tryListen(preferredPort ?? 0, Boolean(preferredPort && preferredPort > 0));
    });
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.refreshChains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.refreshChains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private renderHtml(ok: boolean, message: string): string {
    const color = ok ? "#10b981" : "#ef4444";
    const rawTitle = ok ? "✓ Authorization Successful" : "✕ Authorization Failed";
    const title = escapeHtml(rawTitle);
    const escapedMessage = escapeHtml(message);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #09090b;
    color: #f4f4f5;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
  }
  .card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 16px;
    padding: 36px 32px;
    text-align: center;
    max-width: 420px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  h1 {
    color: ${color};
    font-size: 22px;
    margin: 0 0 12px 0;
    font-weight: 600;
  }
  p {
    color: #a1a1aa;
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${escapedMessage}</p>
  </div>
</body>
</html>`;
  }
}
