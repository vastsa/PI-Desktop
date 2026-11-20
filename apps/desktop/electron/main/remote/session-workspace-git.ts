import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes, IPC, type GitHubPullRequestInput, type LeftoverWorktree,
  type RemoteSessionDeletePreflight, type RemoteSessionGitStatus,
  type WorkspaceGitRepository,
} from "@pi-desktop/shared";
import type { GitHubConnector } from "../github/connector";
import { busyJob, offlineError, remoteCode, remoteError, type HostCall, type SessionWorkspaces, type WorkspaceBinding } from "./session-workspaces";

type PendingRemoval = { hostKey: string; sessionId: string; repository: WorkspaceGitRepository; workBranch?: string };
const ORPHAN_MIN_AGE = 24 * 60 * 60 * 1_000;
const missing = (error: unknown) => remoteCode(error) === ErrorCodes.WORKSPACE_GIT_NOT_FOUND;
const lostRemoval = () => remoteError(ErrorCodes.CONFLICT, "The remote worktree has unpushed work. Confirm deletion after reviewing its status.");

export function createSessionWorkspaceGit(deps: {
  call: HostCall;
  workspaces: SessionWorkspaces;
  connector: Pick<GitHubConnector, "findPullRequest" | "createPullRequest">;
  emit(channel: string, payload: unknown): void;
}) {
  const { call, workspaces, connector, emit } = deps;
  const pushJobs = new Map<string, { hostKey: string; jobId: string }>();
  const pushes = new Map<string, Promise<RemoteSessionGitStatus>>();
  const requests = new Map<string, Promise<Awaited<ReturnType<GitHubConnector["createPullRequest"]>>>>();
  const reconciling = new Map<string, Promise<void>>();
  const lookups = new Map<string, Promise<Awaited<ReturnType<GitHubConnector["findPullRequest"]>>>>();
  const pending = (hostKey: string) => call<{ removals: PendingRemoval[] }>("sessionWorkspace.pendingRemoval.list", { hostKey });
  const discardPending = (hostKey: string, sessionId: string) => call("sessionWorkspace.pendingRemoval.remove", { hostKey, sessionId });
  const load = async (sessionId: string) => {
    const binding = await workspaces.binding(sessionId);
    if (!binding) throw remoteError(ErrorCodes.REMOTE_SESSION_NOT_REPOSITORY, "This is not a repository session");
    return binding;
  };
  const requireReady = async (sessionId: string) => {
    const binding = await load(sessionId);
    if (binding.state !== "ready" || !binding.workBranch) throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "Repository worktree is not ready");
    return { ...binding, workBranch: binding.workBranch };
  };
  async function readStatus(binding: WorkspaceBinding & { workBranch: string }): Promise<RemoteSessionGitStatus> {
    const { sessionId, hostKey, workBranch, baseBranch } = binding;
    try {
      const result = await workspaces.git().status(hostKey, sessionId);
      if (result.worktree.checkoutPresent === false) {
        await workspaces.recoverMissingCheckout(binding, result.worktree);
        throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "The repository checkout is being restored");
      }
      return { reachable: true, workBranch, baseBranch, ahead: result.ahead, behind: result.behind, aheadOfBase: result.aheadOfBase,
        uncommittedFiles: result.uncommittedFiles, unpushedCommits: result.unpushedCommits, pushedOnce: result.pushedOnce };
    } catch (error) {
      if (!offlineError(error)) throw error;
      return { reachable: false, workBranch, baseBranch };
    }
  }
  async function push(sessionId: string) {
    const binding = await requireReady(sessionId);
    const before = await readStatus(binding);
    if (!before.reachable) throw remoteError(ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, "The host is offline");
    if ((!before.unpushedCommits && !before.ahead && before.pushedOnce) || before.aheadOfBase === 0 && !before.pushedOnce) {
      throw remoteError(ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH, "The work branch is already pushed");
    }
    let jobId: string;
    try {
      ({ jobId } = await workspaces.git().push(binding.hostKey, sessionId));
    } catch (error) {
      const active = busyJob(error);
      if (!active) throw error;
      jobId = active;
    }
    pushJobs.set(sessionId, { hostKey: binding.hostKey, jobId });
    const started = Date.now();
    try {
      while (true) {
        const job = await workspaces.git().job(binding.hostKey, jobId);
        if (job.kind !== "push") throw remoteError(ErrorCodes.WORKSPACE_GIT_BUSY, "Another Git operation is running");
        emit(IPC.event.remoteSessionPushProgress, { sessionId, phase: job.phase, progress: job.progress });
        if (job.state === "succeeded") return readStatus(binding);
        if (job.state !== "running") throw remoteError(job.error?.code ?? ErrorCodes.WORKSPACE_GIT_FAILED, job.error?.message ?? "Could not push the work branch");
        await sleep(Date.now() - started < 30_000 ? 1_000 : 2_000, null, { ref: false });
      }
    } finally {
      pushJobs.delete(sessionId);
    }
  }
  async function lookupOpenPullRequest(sessionId: string) {
    const binding = await requireReady(sessionId);
    const found = await connector.findPullRequest(binding.repository, binding.workBranch, "open");
    const pullRequest = found?.state === "open" ? found : null;
    const link = pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null;
    if (link?.number !== binding.pullRequest?.number || link?.url !== binding.pullRequest?.url) {
      workspaces.announce(await workspaces.update(sessionId, { pullRequest: link }));
    }
    return pullRequest;
  }
  function find(sessionId: string) {
    const existing = lookups.get(sessionId);
    if (existing) return existing;
    const task = lookupOpenPullRequest(sessionId).finally(() => lookups.delete(sessionId));
    lookups.set(sessionId, task);
    return task;
  }
  async function create(sessionId: string, input: Pick<GitHubPullRequestInput, "title" | "body" | "draft">) {
    const binding = await requireReady(sessionId);
    const previous = await find(sessionId);
    if (previous) return previous;
    try {
      await api.push(sessionId);
    } catch (error) {
      if (remoteCode(error) !== ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH) throw error;
    }
    const status = await readStatus(binding);
    if (status.aheadOfBase === 0 || !status.pushedOnce && !status.unpushedCommits) {
      const code = status.uncommittedFiles ? ErrorCodes.REMOTE_SESSION_UNCOMMITTED_CHANGES : ErrorCodes.REMOTE_SESSION_NOTHING_TO_PUSH;
      throw remoteError(code, status.uncommittedFiles ? "Commit your changes before opening a pull request" : "There are no commits ahead of the base branch");
    }
    const request = { ...input, head: binding.workBranch, base: binding.baseBranch };
    let created: Awaited<ReturnType<GitHubConnector["createPullRequest"]>>;
    try {
      created = await connector.createPullRequest(binding.repository, request);
    } catch (error) {
      const raced = await find(sessionId).catch(() => null);
      if (!raced) throw error;
      return raced;
    }
    workspaces.announce(await workspaces.update(sessionId, { pullRequest: { number: created.number, url: created.url } }));
    return created;
  }
  async function reconcile(hostKey: string) {
    if (!workspaces.git().supportsSafeRemoval(hostKey)) return;
    const { removals } = await pending(hostKey);
    const worktrees = await workspaces.git().list(hostKey);
    for (const removal of removals) {
      if (await workspaces.binding(removal.sessionId)) continue;
      const tree = worktrees.find((candidate) => candidate.sessionId === removal.sessionId);
      if (tree && (!removal.workBranch || tree.workBranch === removal.workBranch)
        && tree.repository.owner === removal.repository.owner && tree.repository.name === removal.repository.name) {
        try {
          // Offline deletion cannot prove a worktree is clean. Keep any
          // discovered local work for the leftover management view.
          if (!(await workspaces.git().remove(hostKey, tree.sessionId, false)).removed) continue;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      await discardPending(hostKey, removal.sessionId);
    }
    const bound = new Set((await workspaces.listBindings()).map((item) => item.sessionId));
    const pendingIds = new Set(removals.map((item) => item.sessionId));
    for (const tree of worktrees) {
      const age = Date.now() - Date.parse(tree.createdAt);
      if (bound.has(tree.sessionId) || pendingIds.has(tree.sessionId) || !(age >= ORPHAN_MIN_AGE)) continue;
      await workspaces.git().remove(hostKey, tree.sessionId, false).catch((error) => {
        if (!missing(error) && remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_BUSY) throw error;
      });
    }
  }
  const api = {
    async status(sessionId: string) { return readStatus(await requireReady(sessionId)); },
    push(sessionId: string) {
      const current = pushes.get(sessionId);
      if (current) return current;
      const task = push(sessionId).finally(() => pushes.delete(sessionId));
      pushes.set(sessionId, task);
      return task;
    },
    find(sessionId: string) {
      return requests.get(sessionId) ?? find(sessionId);
    },
    create(sessionId: string, input: Pick<GitHubPullRequestInput, "title" | "body" | "draft">) {
      const current = requests.get(sessionId);
      if (current) return current;
      const task = create(sessionId, input).finally(() => requests.delete(sessionId));
      requests.set(sessionId, task);
      return task;
    },
    async preflight(sessionId: string): Promise<RemoteSessionDeletePreflight> {
      const binding = await workspaces.binding(sessionId);
      if (!binding) return { kind: "none" };
      try {
        const status = await workspaces.git().status(binding.hostKey, sessionId);
        const { uncommittedFiles, unpushedCommits } = status;
        if (uncommittedFiles || unpushedCommits) return { kind: "atRisk", uncommittedFiles, unpushedCommits };
        return { kind: "clean" };
      } catch (error) {
        if (missing(error)) return { kind: binding.state === "preparing" || !binding.path ? "none" : "unknown" };
        if (offlineError(error)) return { kind: "unknown" };
        throw error;
      }
    },
    async beforeDelete(sessionId: string, force: boolean) {
      const current = await workspaces.binding(sessionId);
      if (!current) return;
      try {
        if (current.state === "preparing") await workspaces.cancel(sessionId);
        const push = pushJobs.get(sessionId);
        if (push) await workspaces.git().cancelJob(push.hostKey, push.jobId);
        const result = await workspaces.git().remove(current.hostKey, sessionId, force);
        if (!result.removed) throw lostRemoval();
      } catch (error) {
        if (missing(error)) return;
        const legacyHost = !force && [ErrorCodes.HOST_VERSION_MISMATCH, "METHOD_NOT_FOUND"].includes(remoteCode(error) ?? "");
        if (!(legacyHost || offlineError(error) && force)) throw error;
        await call("sessionWorkspace.pendingRemoval.add", {
          sessionId, hostKey: current.hostKey, repository: current.repository, workBranch: current.workBranch,
        });
      }
    },
    reconcile(hostKey: string) {
      const current = reconciling.get(hostKey);
      if (current) return current;
      const task = reconcile(hostKey).finally(() => reconciling.delete(hostKey));
      reconciling.set(hostKey, task);
      return task;
    },
    async leftovers(hostKey: string): Promise<LeftoverWorktree[]> {
      const bound = new Set((await workspaces.listBindings()).map((item) => item.sessionId));
      const result: LeftoverWorktree[] = [];
      for (const tree of await workspaces.git().list(hostKey)) {
        if (bound.has(tree.sessionId)) continue;
        try {
          const status = await workspaces.git().status(hostKey, tree.sessionId);
          result.push({ hostKey, sessionId: tree.sessionId, repository: tree.repository, workBranch: tree.workBranch,
            path: tree.path, createdAt: tree.createdAt, uncommittedFiles: status.uncommittedFiles, unpushedCommits: status.unpushedCommits });
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      return result;
    },
    async removeLeftover(hostKey: string, sessionId: string) {
      if (await workspaces.binding(sessionId)) throw remoteError(ErrorCodes.CONFLICT, "This worktree still belongs to a session");
      const { removed } = await workspaces.git().remove(hostKey, sessionId, true);
      if (removed) await discardPending(hostKey, sessionId);
      return removed;
    },
  };
  return api;
}
