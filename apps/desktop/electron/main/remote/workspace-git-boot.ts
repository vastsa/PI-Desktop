/**
 * Main-process API for git workspaces on a paired remote Host (D687, decision
 * record `remote-git-workspaces`).
 *
 * It is a thin, typed front for the ten owner-only `workspace/git*` RACP
 * operations plus the one thing that needs care here: handing the Host the
 * GitHub token. The token is read from a provider only at the moment it is
 * sent, is sent only over a transport an observer on the network cannot read,
 * and is never logged or placed in an error.
 *
 * Nothing here waits on git. `prepare` and `push` return a job id; callers
 * poll `job`.
 */
import {
  ErrorCodes,
  type WorkspaceGitEnvironment,
  type WorkspaceGitJob,
  type WorkspaceGitRemoveResult,
  type WorkspaceGitRepository,
  type WorkspaceGitStatus,
  type WorkspaceGitWorktree,
} from "@pi-desktop/shared";
import type { RemoteHostRecord } from "./remote-host-registry.js";

/** Every call is short: long work is a job on the Host. */
const REQUEST_TIMEOUT_MS = 30_000;

export type WorkspaceGitCredentialProvider = () => Promise<string | null>;

export type WorkspaceGitBoot = {
  setCredentialProvider(provider: WorkspaceGitCredentialProvider | null): void;
  /** Push or clear the credential on every connected capable host. */
  refreshCredential(): Promise<void>;
  /** Whether the host offers git workspaces; realigns it once when it does not. */
  supported(hostKey: string): Promise<boolean>;
  supportsSafeRemoval(hostKey: string): boolean;
  repository(hostKey: string, repository: WorkspaceGitRepository): Promise<{ path: string; cloned: boolean }>;
  prepare(hostKey: string, input: {
    sessionId: string; repository: WorkspaceGitRepository; baseBranch: string;
    fromSessionId?: string; environment?: WorkspaceGitEnvironment; restoreOnly?: boolean; rerunSetup?: boolean;
  }): Promise<{ jobId: string }>;
  push(hostKey: string, sessionId: string): Promise<{ jobId: string }>;
  job(hostKey: string, jobId: string): Promise<WorkspaceGitJob>;
  cancelJob(hostKey: string, jobId: string): Promise<void>;
  status(hostKey: string, sessionId: string): Promise<WorkspaceGitStatus>;
  remove(hostKey: string, sessionId: string, force: boolean): Promise<WorkspaceGitRemoveResult>;
  list(hostKey: string): Promise<WorkspaceGitWorktree[]>;
};

/** What the boot needs from one connected host. */
export type WorkspaceGitHost = {
  adapter: {
    client: { request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> };
    workspaceCapabilities?(): { workspaceGit?: boolean; workspaceGitSafeRemoval?: boolean } | undefined;
  };
};

export type WorkspaceGitBootDeps = {
  connectedHost(hostKey: string): WorkspaceGitHost | undefined;
  /** Connect the host when it is not; rejects when it cannot be reached. */
  ensureReady(hostKey: string): Promise<unknown>;
  /** Bring the host up to this desktop's release and reconnect; true when it ran. */
  realign(hostKey: string): Promise<boolean>;
  record(hostKey: string): RemoteHostRecord | undefined;
  getInstallationId(): Promise<string>;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function fail(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode, retriable: false });
}

/**
 * The credential may travel only where the path to the Host is encrypted or
 * never leaves this machine: the desktop's own SSH forward, a `wss://` URL, or
 * a loopback `ws://` URL (a forward the user opened themselves).
 */
export function credentialTransportAllowed(record: Pick<RemoteHostRecord, "url" | "metadata"> | undefined): boolean {
  if (!record) return false;
  if (record.metadata?.transport === "ssh") return true;
  let url: URL;
  try { url = new URL(record.url); } catch { return false; }
  if (url.protocol === "wss:") return true;
  return url.protocol === "ws:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}

function errorCodeOf(error: unknown): string {
  const fields = (error ?? {}) as { errorCode?: unknown; code?: unknown };
  const code = fields.errorCode ?? fields.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

export function createWorkspaceGitBoot(deps: WorkspaceGitBootDeps): WorkspaceGitBoot & {
  /** A host connected or reconnected: give its new connection the credential. */
  hostConnected(hostKey: string): Promise<void>;
  hostRemoved(hostKey: string): void;
} {
  let provider: WorkspaceGitCredentialProvider | null = null;
  /** Hosts that have connected at least once; `refreshCredential` walks them. */
  const known = new Set<string>();
  /** Hosts whose token could not be sent because their transport is not safe. */
  const refused = new Set<string>();
  /** The credential push in flight per host; git calls wait for it. */
  const pushes = new Map<string, Promise<void>>();
  /** One realignment per host for this desktop release, shared by concurrent callers. */
  const realignments = new Map<string, Promise<void>>();

  const advertises = (host: WorkspaceGitHost | undefined) => host?.adapter.workspaceCapabilities?.()?.workspaceGit === true;
  const unavailable = () => Object.assign(new Error("remote host is unavailable"), { errorCode: "AGENT_UNAVAILABLE" });

  /** Send or clear the credential on one host. Never throws, never logs a value. */
  async function pushCredential(hostKey: string): Promise<void> {
    const current = provider;
    const host = deps.connectedHost(hostKey);
    if (!host || !advertises(host)) return;
    let token: string | null = null;
    try {
      token = await current?.() ?? null;
    } catch {
      // The provider's error may quote what it failed to read; keep only the fact.
      deps.log("warn", "git credential provider failed; clearing the remote credential", { hostKey });
    }
    if (provider !== current || deps.connectedHost(hostKey) !== host) return;
    try {
      if (token === null) {
        refused.delete(hostKey);
        await host.adapter.client.request("workspace/gitCredentialClear", {}, REQUEST_TIMEOUT_MS);
        return;
      }
      if (!credentialTransportAllowed(deps.record(hostKey))) {
        refused.add(hostKey);
        await host.adapter.client.request("workspace/gitCredentialClear", {}, REQUEST_TIMEOUT_MS);
        deps.log("warn", "git credential not sent: the remote host is not reached over SSH, wss, or loopback", { hostKey, code: ErrorCodes.WORKSPACE_GIT_TRANSPORT_REFUSED });
        return;
      }
      refused.delete(hostKey);
      const installationId = await deps.getInstallationId();
      if (provider !== current || deps.connectedHost(hostKey) !== host) return;
      await host.adapter.client.request("workspace/gitCredentialSet", { installationId, token }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      // Only the code: a message could echo the request.
      deps.log("warn", "git credential could not be delivered to the remote host", { hostKey, code: errorCodeOf(error) });
    }
  }

  /** Serialize pushes per host so an older token can never land after a newer one. */
  function schedulePush(hostKey: string): Promise<void> {
    const task = (pushes.get(hostKey) ?? Promise.resolve()).then(() => pushCredential(hostKey));
    pushes.set(hostKey, task);
    void task.finally(() => { if (pushes.get(hostKey) === task) pushes.delete(hostKey); });
    return task;
  }

  /** A connected host that advertises the capability, or the typed refusal. */
  async function capableHost(hostKey: string): Promise<WorkspaceGitHost> {
    await deps.ensureReady(hostKey);
    const host = deps.connectedHost(hostKey);
    if (!host) throw unavailable();
    if (!advertises(host)) {
      throw fail(ErrorCodes.HOST_VERSION_MISMATCH, "Upgrade pi-host to a matching Desktop release with git workspace support");
    }
    return host;
  }

  async function call<T>(hostKey: string, method: string, params: (installationId: string) => Record<string, unknown>, options: { needsCredential?: boolean; needsSafeRemoval?: boolean } = {}): Promise<T> {
    const host = await capableHost(hostKey);
    let installationId: string;
    try {
      installationId = await deps.getInstallationId();
    } catch {
      throw fail(ErrorCodes.WORKSPACE_GIT_UNAVAILABLE, "this desktop's installation identity is unavailable");
    }
    if (options.needsCredential) {
      // A connect may still be delivering the credential this call depends on.
      await pushes.get(hostKey);
      if (refused.has(hostKey)) {
        throw fail(ErrorCodes.WORKSPACE_GIT_TRANSPORT_REFUSED, "the GitHub credential is only sent to a host reached over SSH, wss://, or a loopback ws:// address");
      }
      if (deps.connectedHost(hostKey) !== host) throw unavailable();
    }
    if (deps.connectedHost(hostKey) !== host) throw unavailable();
    if (options.needsSafeRemoval && host.adapter.workspaceCapabilities?.()?.workspaceGitSafeRemoval !== true) {
      throw fail(ErrorCodes.HOST_VERSION_MISMATCH, "Upgrade pi-host to enable safe worktree removal");
    }
    const result = await host.adapter.client.request<T>(method, params(installationId), REQUEST_TIMEOUT_MS);
    if (deps.connectedHost(hostKey) !== host) throw unavailable();
    return result;
  }

  return {
    setCredentialProvider(next) {
      provider = next;
    },
    async refreshCredential() {
      await Promise.all([...known].map((hostKey) => schedulePush(hostKey)));
    },
    async supported(hostKey) {
      await deps.ensureReady(hostKey);
      if (!deps.connectedHost(hostKey)) throw unavailable();
      if (advertises(deps.connectedHost(hostKey))) return true;
      // The host runs a bundle without the capability. Bring it up to this
      // release once; a second miss is the answer, not a reason to try again.
      let realignment = realignments.get(hostKey);
      if (!realignment) {
        realignment = deps.realign(hostKey).then(() => undefined, () => {
          deps.log("warn", "remote host realignment for git workspaces failed", { hostKey });
        });
        realignments.set(hostKey, realignment);
      }
      await realignment;
      return advertises(deps.connectedHost(hostKey));
    },
    supportsSafeRemoval(hostKey) {
      const capabilities = deps.connectedHost(hostKey)?.adapter.workspaceCapabilities?.();
      return capabilities?.workspaceGit === true && capabilities.workspaceGitSafeRemoval === true;
    },
    repository(hostKey, repository) {
      return call(hostKey, "workspace/gitRepository", () => ({ repository: { owner: repository.owner, name: repository.name } }));
    },
    prepare(hostKey, input) {
      return call(hostKey, "workspace/gitPrepare", (installationId) => ({
        installationId,
        sessionId: input.sessionId,
        repository: { owner: input.repository.owner, name: input.repository.name },
        baseBranch: input.baseBranch,
        ...(input.fromSessionId !== undefined ? { fromSessionId: input.fromSessionId } : {}),
        ...(input.restoreOnly === true ? { restoreOnly: true } : {}),
        ...(input.rerunSetup === true ? { rerunSetup: true } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      }), { needsCredential: !input.restoreOnly && !input.rerunSetup });
    },
    push(hostKey, sessionId) {
      return call(hostKey, "workspace/gitPush", (installationId) => ({ installationId, sessionId }), { needsCredential: true });
    },
    job(hostKey, jobId) {
      return call(hostKey, "workspace/gitJob", () => ({ jobId }));
    },
    async cancelJob(hostKey, jobId) {
      await call(hostKey, "workspace/gitJobCancel", () => ({ jobId }));
    },
    status(hostKey, sessionId) {
      return call(hostKey, "workspace/gitStatus", (installationId) => ({ installationId, sessionId }));
    },
    remove(hostKey, sessionId, force) {
      return call(hostKey, "workspace/gitRemove", (installationId) => ({ installationId, sessionId, force }), { needsSafeRemoval: !force });
    },
    async list(hostKey) {
      const result = await call<{ worktrees?: WorkspaceGitWorktree[] }>(hostKey, "workspace/gitList", (installationId) => ({ installationId }));
      return result.worktrees ?? [];
    },
    hostConnected(hostKey) {
      known.add(hostKey);
      return schedulePush(hostKey);
    },
    hostRemoved(hostKey) {
      known.delete(hostKey);
      refused.delete(hostKey);
      realignments.delete(hostKey);
    },
  };
}
