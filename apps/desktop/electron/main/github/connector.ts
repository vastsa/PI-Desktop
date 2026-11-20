/**
 * The built-in GitHub connector (ADR github-connector).
 *
 * One main-process service owns the user's GitHub credential and everything
 * that can change it: a device login running in the background, a pasted
 * token, and disconnect. The renderer sees an account, its scopes, and a
 * connection state; the token leaves this module only through `token()`,
 * which is for main-process callers and is never wired to IPC.
 *
 * Three rules shape the code:
 *
 * - **One login at a time, and only the current one may store.** A login is
 *   current from `startDeviceLogin` until it finishes, is cancelled, or is
 *   replaced. Starting another, pasting a token, disconnecting, and shutdown
 *   all abort it, and it re-checks that it is still current after every wait,
 *   so a login that outlives its dialog can neither keep polling nor write a
 *   token over a newer decision.
 * - **Store writes are serialized.** A write and a clear never interleave, so
 *   whatever the user did last is what the secret store holds.
 * - **A failed GitHub call is a failure.** It is rethrown typed and never
 *   cached. A 401 additionally marks the stored token as rejected, so Settings
 *   asks the user to connect again instead of showing an account with no
 *   repositories; the credential is kept so they can see which account it is.
 */
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  GITHUB_CONNECTOR_LOGIN_ID,
  IPC,
  githubConnectorScopes,
  isGitHubTokenShape,
  type GitHubBranchList,
  type GitHubConnectorAccount,
  type GitHubConnectorStatus,
  type GitHubPullRequestInput,
  type GitHubPullRequestSummary,
  type GitHubRepositoryList,
  type GitHubRepositoryListInput,
  type GitHubRepositoryRef,
  type GitHubRepositorySummary,
  type OAuthLoginEvent,
} from "@pi-desktop/shared";
import type { GitHubConnectorStore, StoredGitHubCredential } from "./connector-store";
import {
  GITHUB_DEVICE_VERIFICATION_URL,
  type DeviceFlowEvent,
  type GitHubDeviceFlowOptions,
} from "./device-flow";
import { GitHubApiError, type GitHubApi, type GitHubViewer } from "./github-api";

/** How long a repository listing is served from memory. */
export const GITHUB_REPOSITORY_CACHE_MS = 5 * 60_000;

export type GitHubConnector = {
  status(): Promise<GitHubConnectorStatus>;
  /** The stored token. Main-process callers only; never returned over IPC. */
  token(): Promise<string | null>;
  onChange(listener: (status: GitHubConnectorStatus) => void): () => void;
  startDeviceLogin(input: { allowWorkflowScope: boolean }): Promise<{ loginId: string }>;
  cancelLogin(loginId: string): Promise<boolean>;
  setToken(token: string): Promise<GitHubConnectorStatus>;
  disconnect(): Promise<GitHubConnectorStatus>;
  listRepositories(input: GitHubRepositoryListInput): Promise<GitHubRepositoryList>;
  listBranches(repository: GitHubRepositoryRef): Promise<GitHubBranchList>;
  findPullRequest(
    repository: GitHubRepositoryRef,
    head: string,
    state?: "open",
  ): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(
    repository: GitHubRepositoryRef,
    input: GitHubPullRequestInput,
  ): Promise<GitHubPullRequestSummary>;
  /** Abort any login in progress and go quiet. Called on shutdown. */
  cancelPendingLogin(): void;
  dispose(): void;
};

export type GitHubConnectorLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type GitHubConnectorDeps = {
  store: GitHubConnectorStore;
  api: GitHubApi;
  runDeviceFlow: (options: GitHubDeviceFlowOptions) => Promise<{ token: string }>;
  /** Push one event to the renderer. Payloads never hold the token. */
  emit(channel: string, payload: unknown): void;
  /** The OAuth App's public client id; empty when device login is not configured. */
  clientId: string;
  /** The app's guarded external-open helper. */
  openExternal(url: string): Promise<void>;
  now(): Date;
  log: GitHubConnectorLog;
};

type Login = { loginId: string; controller: AbortController };

type Listing = {
  token: string;
  fetchedAt: number;
  repositories: GitHubRepositorySummary[];
  truncated: boolean;
  ssoPartial: boolean;
};

/** One login event without the envelope `emitLogin` adds. */
type LoginEventBody = OAuthLoginEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "loginId" | "vendorId">
    : never
  : never;

let activeConnector: GitHubConnector | null = null;

/** The connector the running app constructed, for other main-process modules. */
export function getActiveGitHubConnector(): GitHubConnector | null {
  return activeConnector;
}

export function setActiveGitHubConnector(connector: GitHubConnector | null): void {
  activeConnector = connector;
}

function codeOf(error: unknown): string | undefined {
  const fields = error as { errorCode?: unknown; data?: { errorCode?: unknown } } | null;
  const code = fields?.data?.errorCode ?? fields?.errorCode;
  return typeof code === "string" ? code : undefined;
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join("[redacted]") : value;
}

function messageOf(error: unknown, token: string): string {
  return redact(error instanceof Error ? error.message : String(error), token);
}

/**
 * The same failure, guaranteed not to name the token. An error that already
 * does not is returned as it is, so its code and details survive.
 */
function withoutToken(error: unknown, token: string): unknown {
  const raw = error instanceof Error ? error.message : String(error);
  if (!token || (error instanceof Error && !raw.includes(token))) return error;
  return new GitHubApiError(codeOf(error) ?? ErrorCodes.INTERNAL, redact(raw, token), {
    retriable: (error as { retriable?: unknown } | null)?.retriable === true,
  });
}

function isGitHubPage(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === "https://github.com";
  } catch {
    return false;
  }
}

export function createGitHubConnector(deps: GitHubConnectorDeps): GitHubConnector {
  const deviceLoginAvailable = deps.clientId.trim().length > 0;
  const listeners = new Set<(status: GitHubConnectorStatus) => void>();

  let disposed = false;
  let currentLogin: Login | null = null;
  /** Bumped by every disconnect, so a token still being validated is dropped. */
  let disconnects = 0;
  /** The stored token GitHub last answered 401 for, if it is still unexplained. */
  let rejectedToken: string | null = null;
  let cache: Listing | null = null;
  let loading: { token: string; promise: Promise<Listing> } | null = null;
  /** Bumped whenever the cache is dropped, so a slow listing cannot refill it. */
  let cacheGeneration = 0;
  let storeQueue: Promise<unknown> = Promise.resolve();

  /** Run one store mutation after every earlier one has settled. */
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = storeQueue.then(work, work);
    storeQueue = next.catch(() => undefined);
    return next;
  };

  const dropCache = () => {
    cache = null;
    loading = null;
    cacheGeneration += 1;
  };

  const toStatus = (credential: StoredGitHubCredential | null): GitHubConnectorStatus => {
    const status: GitHubConnectorStatus = { connected: credential !== null, deviceLoginAvailable };
    if (!credential) return status;
    const account: GitHubConnectorAccount = { login: credential.login };
    if (credential.name !== undefined) account.name = credential.name;
    if (credential.avatarUrl !== undefined) account.avatarUrl = credential.avatarUrl;
    status.account = account;
    status.scopes = [...credential.scopes];
    status.tokenKind = credential.kind;
    if (rejectedToken !== null && rejectedToken === credential.token) {
      status.needsReauthentication = true;
    }
    return status;
  };

  const emitChange = (status: GitHubConnectorStatus) => {
    if (disposed) return;
    deps.emit(IPC.event.githubConnectorChanged, status);
    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch (error) {
        deps.log("warn", "GitHub connector listener failed", { errorCode: codeOf(error) });
      }
    }
  };

  /** Re-read the store and tell everyone what the connection looks like now. */
  const announce = async () => {
    try {
      emitChange(toStatus(await deps.store.read()));
    } catch (error) {
      deps.log("warn", "GitHub connector status could not be read", { errorCode: codeOf(error) });
    }
  };

  const emitLogin = (login: Login, body: LoginEventBody) => {
    if (disposed) return;
    const event = {
      loginId: login.loginId,
      vendorId: GITHUB_CONNECTOR_LOGIN_ID,
      ...body,
    } as OAuthLoginEvent;
    deps.emit(IPC.event.githubConnectorLogin, event);
  };

  /** End the login in progress, if any: no more polling, no token stored. */
  const abandonLogin = () => {
    const login = currentLogin;
    if (!login) return;
    currentLogin = null;
    login.controller.abort();
    emitLogin(login, { kind: "cancelled" });
  };

  /**
   * Store a validated token with its account. `stillWanted` is asked inside
   * the store queue, immediately before the write, and a false answer stores
   * nothing.
   */
  const storeCredential = (
    token: string,
    kind: StoredGitHubCredential["kind"],
    viewer: GitHubViewer,
    stillWanted: () => boolean,
  ): Promise<GitHubConnectorStatus | null> =>
    serialized(async () => {
      if (!stillWanted()) return null;
      const credential: StoredGitHubCredential = {
        version: 1,
        token,
        kind,
        login: viewer.login,
        scopes: viewer.scopes.filter((scope) => typeof scope === "string"),
        savedAt: deps.now().toISOString(),
      };
      if (typeof viewer.name === "string" && viewer.name) credential.name = viewer.name;
      if (typeof viewer.avatarUrl === "string" && viewer.avatarUrl) {
        credential.avatarUrl = viewer.avatarUrl;
      }
      await deps.store.write(credential);
      dropCache();
      rejectedToken = null;
      return toStatus(credential);
    });

  const onDeviceFlowEvent = (login: Login, event: DeviceFlowEvent) => {
    if (currentLogin !== login) return;
    if (event.kind === "progress") {
      emitLogin(login, { kind: "progress", message: event.message });
      return;
    }
    // The page where the user authorizes this app is opened by main, so it is
    // only ever a github.com address.
    const verificationUri = isGitHubPage(event.verificationUri)
      ? event.verificationUri
      : GITHUB_DEVICE_VERIFICATION_URL;
    emitLogin(login, {
      kind: "deviceCode",
      userCode: event.userCode,
      verificationUri,
      intervalSeconds: event.intervalSeconds,
      expiresInSeconds: event.expiresInSeconds,
    });
    void deps.openExternal(verificationUri).catch((error: unknown) => {
      // The dialog shows the address and the code, so the user can still go there.
      deps.log("warn", "Could not open the GitHub sign-in page", { errorCode: codeOf(error) });
    });
  };

  /** The background half of a device login. Never rejects. */
  const runLogin = async (login: Login, allowWorkflowScope: boolean): Promise<void> => {
    let token = "";
    try {
      const result = await deps.runDeviceFlow({
        clientId: deps.clientId,
        scopes: githubConnectorScopes(allowWorkflowScope),
        signal: login.controller.signal,
        onEvent: (event) => onDeviceFlowEvent(login, event),
      });
      if (currentLogin !== login) return;
      token = result.token;
      const viewer = await deps.api.viewer(token);
      const status = await storeCredential(token, "oauth", viewer, () => currentLogin === login);
      if (!status || currentLogin !== login) return;
      currentLogin = null;
      deps.log("info", "GitHub connected", { kind: "oauth", scopes: status.scopes });
      emitLogin(login, {
        kind: "done",
        providerId: GITHUB_CONNECTOR_LOGIN_ID,
        accountLabel: viewer.login,
      });
      emitChange(status);
    } catch (error) {
      // Whoever made this login stale already told its dialog.
      if (currentLogin !== login) return;
      currentLogin = null;
      if (isAbort(error)) {
        emitLogin(login, { kind: "cancelled" });
        return;
      }
      const code = codeOf(error);
      deps.log("warn", "GitHub sign-in failed", { errorCode: code });
      // The code lets the renderer show its own translation of the failure.
      emitLogin(login, {
        kind: "error",
        message: messageOf(error, token),
        ...(code ? { code } : {}),
      });
    }
  };

  /**
   * Spend the credential on one GitHub call. A 401 marks the token rejected;
   * a call that works again clears the mark.
   */
  const spend = async <T>(
    credential: StoredGitHubCredential,
    work: (token: string) => Promise<T>,
  ): Promise<T> => {
    const { token } = credential;
    let result: T;
    try {
      result = await work(token);
    } catch (error) {
      if (codeOf(error) === ErrorCodes.GITHUB_AUTH_FAILED && rejectedToken !== token) {
        rejectedToken = token;
        // A list read with a token GitHub no longer accepts must not keep
        // being served as if the account were fine.
        dropCache();
        deps.log("warn", "GitHub rejected the saved token", { status: 401 });
        await announce();
      }
      throw withoutToken(error, token);
    }
    if (rejectedToken === token) {
      rejectedToken = null;
      await announce();
    }
    return result;
  };

  const requireCredential = async (): Promise<StoredGitHubCredential> => {
    const credential = await deps.store.read();
    if (!credential) {
      throw new GitHubApiError(
        ErrorCodes.GITHUB_NOT_CONNECTED,
        "No GitHub account is connected. Connect one in Settings.",
      );
    }
    return credential;
  };

  const fetchListing = async (
    credential: StoredGitHubCredential,
    generation: number,
  ): Promise<Listing> => {
    const result = await spend(credential, (token) => deps.api.listRepositories(token));
    const listing: Listing = {
      token: credential.token,
      fetchedAt: deps.now().getTime(),
      repositories: result.repositories,
      truncated: result.truncated === true,
      ssoPartial: result.ssoPartial === true,
    };
    // Only a complete, successful read of the still-current account is kept.
    if (generation === cacheGeneration) cache = listing;
    return listing;
  };

  const loadListing = (credential: StoredGitHubCredential): Promise<Listing> => {
    const { token } = credential;
    if (
      cache &&
      cache.token === token &&
      deps.now().getTime() - cache.fetchedAt < GITHUB_REPOSITORY_CACHE_MS
    ) {
      return Promise.resolve(cache);
    }
    if (loading && loading.token === token) return loading.promise;
    const entry = { token, promise: fetchListing(credential, cacheGeneration) };
    loading = entry;
    const done = () => {
      if (loading === entry) loading = null;
    };
    entry.promise.then(done, done);
    return entry.promise;
  };

  return {
    async status() {
      return toStatus(await deps.store.read());
    },

    async token() {
      const credential = await deps.store.read();
      return credential && credential.token !== rejectedToken ? credential.token : null;
    },

    cancelPendingLogin: abandonLogin,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async startDeviceLogin(input) {
      if (!deviceLoginAvailable || disposed) {
        throw new GitHubApiError(
          ErrorCodes.GITHUB_DEVICE_FLOW_UNAVAILABLE,
          "Sign-in with a code is not configured in this build. Use a personal access token.",
        );
      }
      abandonLogin();
      const login: Login = { loginId: randomUUID(), controller: new AbortController() };
      currentLogin = login;
      void runLogin(login, input?.allowWorkflowScope === true);
      return { loginId: login.loginId };
    },

    async cancelLogin(loginId) {
      if (!currentLogin || currentLogin.loginId !== loginId) return false;
      abandonLogin();
      return true;
    },

    async setToken(input) {
      const token = typeof input === "string" ? input.trim() : "";
      if (!isGitHubTokenShape(token)) {
        throw new GitHubApiError(
          ErrorCodes.GITHUB_INVALID_TOKEN,
          "That does not look like a GitHub token.",
        );
      }
      const disconnectsAtStart = disconnects;
      let viewer: GitHubViewer;
      try {
        viewer = await deps.api.viewer(token);
      } catch (error) {
        if (codeOf(error) === ErrorCodes.GITHUB_AUTH_FAILED) {
          throw new GitHubApiError(
            ErrorCodes.GITHUB_INVALID_TOKEN,
            "GitHub did not accept that token.",
            { status: 401 },
          );
        }
        throw withoutToken(error, token);
      }
      // The pasted token is the user's latest decision; a login still waiting
      // for approval must not overwrite it later.
      abandonLogin();
      let status: GitHubConnectorStatus | null;
      try {
        status = await storeCredential(
          token,
          "pat",
          viewer,
          () => disconnects === disconnectsAtStart,
        );
      } catch (error) {
        throw withoutToken(error, token);
      }
      if (!status) {
        throw new GitHubApiError(
          ErrorCodes.CONFLICT,
          "GitHub was disconnected before the token was saved.",
        );
      }
      deps.log("info", "GitHub connected", { kind: "pat", scopes: status.scopes });
      emitChange(status);
      return status;
    },

    async disconnect() {
      // Invalidate first, synchronously: anything still in flight sees it.
      disconnects += 1;
      abandonLogin();
      dropCache();
      await serialized(() => deps.store.clear());
      rejectedToken = null;
      deps.log("info", "GitHub disconnected");
      const status = toStatus(null);
      emitChange(status);
      return status;
    },

    async listRepositories(input) {
      const credential = await requireCredential();
      if (input?.refresh === true) dropCache();
      const listing = await loadListing(credential);
      const query = typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
      const list: GitHubRepositoryList = {
        repositories: query
          ? listing.repositories.filter((entry) => entry.fullName.toLowerCase().includes(query))
          : [...listing.repositories],
        truncated: listing.truncated,
      };
      // Incomplete stays incomplete, whether cached or narrowed by a query.
      if (listing.ssoPartial) list.ssoPartial = true;
      return list;
    },

    async listBranches(repository) {
      const credential = await requireCredential();
      return spend(credential, (token) => deps.api.listBranches(token, repository));
    },

    async findPullRequest(repository, head, ...filter) {
      const credential = await requireCredential();
      return spend(credential, (token) => deps.api.findPullRequest(token, repository, head, ...filter));
    },

    async createPullRequest(repository, input) {
      const credential = await requireCredential();
      return spend(credential, (token) => deps.api.createPullRequest(token, repository, input));
    },

    dispose() {
      const login = currentLogin;
      currentLogin = null;
      disposed = true;
      login?.controller.abort();
      listeners.clear();
    },
  };
}
