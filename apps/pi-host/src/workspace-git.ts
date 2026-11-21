/**
 * The owner-only `workspaceGit` service of `pi-host` (D687).
 *
 * host-core owns every git invocation and the worktree registry; this module
 * forwards the validated RACP operations to it and owns the one thing
 * host-core must never hold: the GitHub token. The token goes to the loopback
 * credential proxy and stays in this process's memory. host-core only ever
 * receives the proxy address of one session's scope.
 */
import { createHash } from "node:crypto";

import { RacpError } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import type { RacpHostOperations } from "@pi-desktop/racp";
import { WORKSPACE_GIT_WORK_BRANCH_PREFIX, type WorkspaceGitRepository, type WorkspaceGitWorktree } from "@pi-desktop/shared";

import type { GitCredentialProxy } from "./git-credential-proxy.js";

type Owner = { deviceId: string; connectionId: string };
type WorkspaceGitOperations = NonNullable<RacpHostOperations["workspaceGit"]>;

/** Connection ids are random and never reused; this only has to outlive in-flight requests. */
const MAX_CLOSED_CONNECTIONS = 1024;

/**
 * The first 12 lowercase hex characters of
 * `SHA-256(installationId + "\n" + sessionId)`. host-core computes the same
 * value in Rust (`workspace_git::layout::short_id`); both test suites pin one
 * vector.
 */
export function workspaceGitShortId(installationId: string, sessionId: string): string {
  return createHash("sha256").update(`${installationId}\n${sessionId}`, "utf8").digest("hex").slice(0, 12);
}

/** `pi-desktop/<short id>`: the only branch the session's proxy scope may push. */
export function workspaceGitWorkBranch(installationId: string, sessionId: string): string {
  return `${WORKSPACE_GIT_WORK_BRANCH_PREFIX}${workspaceGitShortId(installationId, sessionId)}`;
}

function hostError(error: unknown): never {
  if (error instanceof RacpError) throw error;
  const code = (error as { data?: { errorCode?: string } })?.data?.errorCode ?? (error as { errorCode?: string })?.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code?.startsWith("WORKSPACE_GIT_")) {
    const jobId = (error as { data?: { jobId?: unknown } })?.data?.jobId;
    throw new RacpError(code, message, { details: typeof jobId === "string" ? { jobId } : undefined });
  }
  if (code === "METHOD_NOT_FOUND") throw new RacpError(code, message);
  if (code === "INVALID_ARGUMENT" || code === "INVALID_PARAMS") throw new RacpError("INVALID_ARGUMENT", message);
  if (code === "HOST_UNAVAILABLE" || code === "HOST_SHUTTING_DOWN") throw new RacpError("AGENT_UNAVAILABLE", message, { retriable: true });
  throw new RacpError("INTERNAL", message, { details: code ? { code } : undefined });
}

export function createWorkspaceGit(deps: {
  getHost: () => HostRpc | null;
  workspacesRoot: string;
  proxy: GitCredentialProxy;
}): WorkspaceGitOperations & { proxyUrlFor(connectionId: string, sessionId: string): string | undefined; proxyUrlForPath(connectionId: string, sessionId: string, path: string): Promise<string | undefined> } {
  const { getHost, workspacesRoot, proxy } = deps;
  /** The installation a live connection last named; it selects that connection's scopes. */
  const installationOf = new Map<string, string>();
  /** Live connections that set a token, per installation. The token lives while one remains. */
  const holders = new Map<string, Set<string>>();
  /** Proxy address per `(installation, session)` scope. */
  const scopes = new Map<string, { url: string; repository: WorkspaceGitRepository }>();
  const preparations = new Map<string, { jobId: string; installationId: string; sessionId: string }>();
  const closed = new Set<string>();
  const scopeKey = (installationId: string, sessionId: string) => JSON.stringify([installationId, sessionId]);
  const unavailable = () => new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });

  /** One host-core call; a host that was replaced meanwhile never counts as success. */
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const host = getHost();
    if (!host) throw unavailable();
    const result = await host.call<T>(method, { ...params, workspacesRoot }).catch(hostError);
    if (getHost() !== host) throw unavailable();
    return result;
  }

  function registerScope(installationId: string, sessionId: string, repository: WorkspaceGitRepository): string {
    const url = proxy.register({
      installationId, sessionId,
      repository: { owner: repository.owner, name: repository.name },
      workBranch: workspaceGitWorkBranch(installationId, sessionId),
    });
    scopes.set(scopeKey(installationId, sessionId), { url, repository });
    return url;
  }

  /** Stop counting this connection as a holder of its installation's token. */
  function release(connectionId: string): void {
    for (const [installationId, connections] of holders) {
      if (!connections.delete(connectionId) || connections.size > 0) continue;
      holders.delete(installationId);
      proxy.setToken(installationId, null);
    }
  }

  function attach(owner: Owner, installationId: string): void {
    if (closed.has(owner.connectionId)) throw new RacpError("CONFLICT", "the connection is closed");
    installationOf.set(owner.connectionId, installationId);
  }

  async function listWorktrees(installationId: string): Promise<WorkspaceGitWorktree[]> {
    const result = await call<{ worktrees?: WorkspaceGitWorktree[] }>("workspaceGit.list", { installationId });
    return result.worktrees ?? [];
  }

  return {
    safeRemoval: true,
    async setCredential(input, owner) {
      if (!getHost()) throw unavailable();
      attach(owner, input.installationId);
      // A connection holds at most one installation's token.
      const previous = [...holders].find(([installationId, connections]) => installationId !== input.installationId && connections.has(owner.connectionId));
      if (previous) release(owner.connectionId);
      const connections = holders.get(input.installationId) ?? new Set<string>();
      connections.add(owner.connectionId);
      holders.set(input.installationId, connections);
      proxy.setToken(input.installationId, input.token);
      // Worktrees that outlived a `pi-host` restart need their scopes back
      // before their tools can reach the proxy.
      for (const worktree of await listWorktrees(input.installationId)) {
        registerScope(input.installationId, worktree.sessionId, worktree.repository);
      }
    },
    async clearCredential(owner) {
      release(owner.connectionId);
    },
    async repository(input) {
      return call("workspaceGit.repository", { repository: input.repository });
    },
    async prepare(input, owner) {
      if (!getHost()) throw unavailable();
      attach(owner, input.installationId);
      const key = scopeKey(input.installationId, input.sessionId);
      const scope = scopes.get(key);
      if (scope && (scope.repository.owner !== input.repository.owner || scope.repository.name !== input.repository.name)) {
        const pending = preparations.get(key);
        if (pending) {
          const job = await call<Awaited<ReturnType<WorkspaceGitOperations["job"]>>>("workspaceGit.job", { jobId: pending.jobId })
            .catch((error: RacpError) => {
              if (error.code !== "WORKSPACE_GIT_JOB_NOT_FOUND") throw error;
              return null;
            });
          if (job?.state === "running") throw new RacpError("WORKSPACE_GIT_BUSY", "a git job for this session is still running", { details: { jobId: pending.jobId } });
        }
        const worktree = (await listWorktrees(input.installationId)).find((candidate) => candidate.sessionId === input.sessionId);
        if (worktree && (worktree.repository.owner !== input.repository.owner || worktree.repository.name !== input.repository.name)) {
          throw new RacpError("INVALID_ARGUMENT", "the session already belongs to a repository");
        }
      }
      const url = registerScope(input.installationId, input.sessionId, input.repository);
      const { rerunSetup, ...prepareInput } = input;
      const result = await call<Awaited<ReturnType<WorkspaceGitOperations["prepare"]>>>("workspaceGit.prepare", {
        ...prepareInput,
        ...(rerunSetup === true ? { rerunSetup: true } : {}),
        gitProxy: { url },
      });
      preparations.set(key, { jobId: result.jobId, sessionId: input.sessionId, installationId: input.installationId });
      return result;
    },
    async push(input, owner) {
      if (!getHost()) throw unavailable();
      attach(owner, input.installationId);
      let url = scopes.get(scopeKey(input.installationId, input.sessionId))?.url;
      if (!url) {
        const worktree = (await listWorktrees(input.installationId)).find((candidate) => candidate.sessionId === input.sessionId);
        if (!worktree) throw new RacpError("WORKSPACE_GIT_NOT_FOUND", "this host has no worktree for the session");
        url = registerScope(input.installationId, input.sessionId, worktree.repository);
      }
      return call("workspaceGit.push", { gitProxy: { url }, installationId: input.installationId, sessionId: input.sessionId });
    },
    async job(input) {
      const result = await call<Awaited<ReturnType<WorkspaceGitOperations["job"]>>>("workspaceGit.job", { jobId: input.jobId });
      if (result.state === "running" || result.kind !== "prepare") return result;
      for (const [key, pending] of preparations) {
        if (pending.jobId !== input.jobId) continue;
        preparations.delete(key);
        if (result.state !== "succeeded") {
          scopes.delete(key);
          proxy.unregister(pending.installationId, pending.sessionId);
        }
        break;
      }
      return result;
    },
    async cancelJob(input) {
      await call("workspaceGit.jobCancel", { jobId: input.jobId });
    },
    async status(input) {
      return call("workspaceGit.status", { installationId: input.installationId, sessionId: input.sessionId });
    },
    async remove(input) {
      const session = { installationId: input.installationId, sessionId: input.sessionId };
      // An older host-core does not recognize the guarded method. Its legacy
      // removal must never be used for an unattended request.
      const result = await (input.force
        ? call<Awaited<ReturnType<WorkspaceGitOperations["remove"]>>>("workspaceGit.remove", { ...session, force: true })
        : call<Awaited<ReturnType<WorkspaceGitOperations["remove"]>>>("workspaceGit.removeSafely", session));
      if (result.removed) {
        const key = scopeKey(input.installationId, input.sessionId);
        scopes.delete(key);
        preparations.delete(key);
        proxy.unregister(input.installationId, input.sessionId);
      }
      return result;
    },
    async list(input) {
      return listWorktrees(input.installationId);
    },
    async disconnect(connectionId) {
      closed.add(connectionId);
      while (closed.size > MAX_CLOSED_CONNECTIONS) closed.delete(closed.values().next().value!);
      installationOf.delete(connectionId);
      release(connectionId);
    },
    async proxyUrlForPath(connectionId, sessionId, path) {
      const { scope } = await call<{ scope: { installationId: string; sessionId: string; repository: WorkspaceGitRepository } | null }>("workspaceGit.scopeForPath", { path });
      // Absence leaves host-core's no-credential rewrite in effect. A
      // workspace under another installation cannot borrow its token.
      if (!scope) return undefined;
      if (scope.sessionId !== sessionId || scope.installationId !== installationOf.get(connectionId)) return proxy.unauthorizedUrl?.();
      return registerScope(scope.installationId, scope.sessionId, scope.repository);
    },
    proxyUrlFor(connectionId, sessionId) {
      const installationId = installationOf.get(connectionId);
      return installationId ? scopes.get(scopeKey(installationId, sessionId))?.url : undefined;
    },
  };
}
