import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes, IPC, type ProjectGroupRecord, type RemoteEnvironment,
  type RemoteEnvironmentInput, type RemoteSessionTarget, type RemoteSessionWorkspaceStart,
  type SessionRemoteRepository, type SessionSummary, type WorkspaceGitJob,
  type WorkspaceGitWorktree,
} from "@pi-desktop/shared";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import type { GitHubConnector } from "../github/connector";

export type HostCall = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
export type WorkspaceBinding = SessionRemoteRepository & {
  sessionId: string;
  fromSessionId?: string | null;
  path?: string | null;
  jobId?: string | null;
};
export type WorkspaceStart = RemoteSessionWorkspaceStart & { fromSessionId?: string };

export const remoteError = (errorCode: string, message: string) => Object.assign(new Error(message), { errorCode });
export function remoteCode(error: unknown): string | undefined {
  const value = error as { errorCode?: string; code?: string; data?: { errorCode?: string } } | undefined;
  return value?.data?.errorCode ?? value?.errorCode ?? value?.code;
}
export function offlineError(error: unknown): boolean {
  return ["AGENT_UNAVAILABLE", "HOST_UNAVAILABLE", "TIMEOUT", "REMOTE_TARGET_HOST_OFFLINE", "REMOTE_DISCONNECTED", "HOST_DISCONNECTED", "NOT_CONNECTED"].includes(remoteCode(error) ?? "");
}
export function busyJob(error: unknown): string | undefined {
  if (remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_BUSY) return undefined;
  const value = error as { data?: { jobId?: string }; details?: { jobId?: string; details?: { jobId?: string } } };
  return value.data?.jobId ?? value.details?.jobId ?? value.details?.details?.jobId;
}

export function createSessionWorkspaces(deps: {
  call: HostCall;
  hosts: () => RemoteHostsBoot | null;
  connector: Pick<GitHubConnector, "status">;
  emit: (channel: string, payload: unknown) => void;
  log: (message: string, error: unknown) => void;
}) {
  const { call, hosts, connector, emit, log } = deps;
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const starting = new Set<string>();
  const recovering = new Set<string>();
  const rerunSetups = new Set<string>();
  let disposed = false;
  const git = () => {
    const boot = hosts();
    if (!boot) throw remoteError(ErrorCodes.HOST_UNAVAILABLE, "Remote hosts are unavailable");
    return boot.workspaceGit;
  };
  const binding = async (sessionId: string) => (await call<{ binding: WorkspaceBinding | null }>("sessionWorkspace.get", { sessionId })).binding;
  const update = async (sessionId: string, patch: Record<string, unknown>) =>
    (await call<{ binding: WorkspaceBinding }>("sessionWorkspace.update", { sessionId, patch })).binding;
  const listBindings = async (states?: string[]) =>
    (await call<{ bindings: WorkspaceBinding[] }>("sessionWorkspace.list", { states })).bindings;
  const list = async (): Promise<RemoteEnvironment[]> => {
    const [paired, stored] = await Promise.all([
      hosts()?.list() ?? [],
      call<{ environments: Omit<RemoteEnvironment, "isDefault">[] }>("environments.list"),
    ]);
    return paired.flatMap((host) => {
      const id = `default:${host.hostKey}`;
      const entries = stored.environments.filter((env) => env.hostKey === host.hostKey);
      const custom = entries.filter((env) => env.id !== id).map((env) => ({ ...env, isDefault: false }));
      const base = entries.find((env) => env.id === id) ?? {
        id, name: host.label, hostKey: host.hostKey, setupScript: "", variables: [],
      };
      return [{ ...base, isDefault: true }, ...custom];
    });
  };
  async function getEnvironment(id: string) {
    const environment = (await list()).find((entry) => entry.id === id);
    if (!environment) throw remoteError(ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND, "Remote environment no longer exists");
    return environment;
  }
  async function announceEnvironments() {
    emit(IPC.event.environmentsChanged, { environments: await list() });
  }
  function publicBinding(b: WorkspaceBinding, job?: WorkspaceGitJob): SessionRemoteRepository {
    const { environmentId, hostKey, repository, baseBranch, state, workBranch, setup, pullRequest, error } = b;
    const liveSetup = job?.phase === "runningSetup"
      ? (job.setupLogTail ? { status: "running" as const, logTail: job.setupLogTail } : { status: "running" as const })
      : setup;
    return { environmentId, hostKey, repository, baseBranch, state,
      ...(workBranch ? { workBranch } : {}), ...(liveSetup ? { setup: liveSetup } : {}),
      ...(pullRequest ? { pullRequest } : {}), ...(error ? { error } : {}),
      ...(job ? { phase: job.phase, progress: job.progress } : {}),
    };
  }
  function announce(b: WorkspaceBinding, job?: WorkspaceGitJob) {
    const remoteRepository = publicBinding(b, job);
    emit(IPC.event.remoteSessionWorkspaceChanged, { sessionId: b.sessionId, remoteRepository });
    return remoteRepository;
  }
  async function prepare(b: WorkspaceBinding, rerunSetup = false): Promise<string> {
    // A bound checkout can be restored after its environment has been removed.
    // The Host owns the original variables and branch for this registration.
    let environment: RemoteEnvironment | null = null;
    if (rerunSetup) {
      environment = await getEnvironment(b.environmentId).catch((error) => {
        if (remoteCode(error) === ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND) return null;
        throw error;
      });
    } else if (!b.path) {
      environment = await getEnvironment(b.environmentId);
    }
    try {
      const result = await git().prepare(b.hostKey, {
        sessionId: b.sessionId, repository: b.repository, baseBranch: b.baseBranch,
        ...(rerunSetup ? {
          rerunSetup: true,
          ...(environment ? { environment: { variables: environment.variables, setupScript: environment.setupScript } } : {}),
        } : environment ? {
          ...(b.fromSessionId ? { fromSessionId: b.fromSessionId } : {}),
          environment: { variables: environment.variables, setupScript: environment.setupScript },
        } : { restoreOnly: true }),
      });
      return result.jobId;
    } catch (error) {
      const jobId = busyJob(error);
      if (jobId) return jobId;
      throw error;
    }
  }
  function readyPatch(worktree: WorkspaceGitWorktree) {
    return { state: "ready", path: worktree.path, workBranch: worktree.workBranch, setup: worktree.setup, jobId: null, error: null };
  }
  async function monitor(sessionId: string, signal: AbortSignal) {
    const active = async () => {
      if (signal.aborted) return null;
      const current = await binding(sessionId);
      return !signal.aborted && current?.state === "preparing" ? current : null;
    };
    const save = async (patch: Record<string, unknown>) => {
      if (!await active()) return;
      const current = await update(sessionId, patch);
      if (!signal.aborted) announce(current);
    };
    const initial = await active();
    if (!initial) return;
    const started = Date.now();
    let previous = "";
    const isRerunSetup = rerunSetups.has(sessionId);
    try {
      let restoredMissingCheckout = false;
      let jobId = initial.jobId ?? await prepare(initial, isRerunSetup);
      if ((await binding(sessionId))?.state === "preparing") {
        await update(sessionId, { jobId });
      }
      while (true) {
        const current = await active();
        if (!current) return;
        let job: WorkspaceGitJob;
        try {
          job = await git().job(current.hostKey, jobId);
        } catch (error) {
          if (remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND) throw error;
          const worktree = (await git().list(current.hostKey)).find((item) => item.sessionId === sessionId);
          if (!worktree || worktree.setup.status === "running") throw error;
          if (worktree.checkoutPresent === false) {
            if (restoredMissingCheckout || !await active()) throw error;
            restoredMissingCheckout = true;
            const recovery = await update(sessionId, { path: worktree.path, workBranch: worktree.workBranch, jobId: null });
            jobId = await prepare(recovery, isRerunSetup);
            if ((await binding(sessionId))?.state === "preparing") await update(sessionId, { jobId });
            continue;
          }
          await save(readyPatch(worktree));
          return;
        }
        if (!await active()) return;
        if (job.state === "succeeded" && job.worktree) {
          await save(readyPatch(job.worktree));
          return;
        }
        if (job.state !== "running") {
          const failure = job.error ?? { code: ErrorCodes.WORKSPACE_GIT_FAILED, message: "Workspace preparation did not complete" };
          await save({ state: "failed", error: failure, jobId: null });
          return;
        }
        const progress = JSON.stringify([job.phase, job.progress, job.setupLogTail]);
        if (progress !== previous) {
          previous = progress;
          announce(current, job);
        }
        await sleep(Date.now() - started < 30_000 ? 1_000 : 2_000, null, { signal });
      }
    } catch (error) {
      if (!signal.aborted && !offlineError(error)) {
        await save({ state: "failed", jobId: null, error: {
          code: remoteCode(error) ?? "WORKSPACE_GIT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        } });
      }
    } finally {
      rerunSetups.delete(sessionId);
    }
  }
  function watch(sessionId: string) {
    if (disposed || jobs.has(sessionId)) return;
    const controller = new AbortController();
    const done = monitor(sessionId, controller.signal).catch((error) => log("Could not monitor repository workspace", error))
      .finally(() => jobs.delete(sessionId));
    jobs.set(sessionId, { controller, done });
  }

  async function beginPreparation(sessionId: string) {
    const result = announce(await update(sessionId, { state: "preparing", jobId: null, error: null }));
    watch(sessionId);
    return result;
  }

  async function recoverMissingCheckout(expected: WorkspaceBinding, worktree: WorkspaceGitWorktree) {
    const { sessionId } = expected;
    if (worktree.checkoutPresent !== false || worktree.sessionId !== sessionId
      || worktree.path !== expected.path || worktree.workBranch !== expected.workBranch
      || worktree.repository.owner !== expected.repository.owner || worktree.repository.name !== expected.repository.name
      || disposed || recovering.has(sessionId)) return;
    recovering.add(sessionId);
    try {
      await jobs.get(sessionId)?.done;
      const current = await binding(sessionId);
      if (current?.state === "ready" && current.hostKey === expected.hostKey
        && current.path === expected.path && current.workBranch === expected.workBranch && !disposed) {
        await beginPreparation(sessionId);
      }
    } finally {
      recovering.delete(sessionId);
    }
  }

  async function start(input: WorkspaceStart) {
    if (starting.has(input.sessionId)) throw remoteError(ErrorCodes.CONFLICT, "The session already has a workspace starting");
    starting.add(input.sessionId);
    try {
      const environment = await getEnvironment(input.environmentId);
      const { binding: created } = await call<{ binding: WorkspaceBinding }>("sessionWorkspace.bind", { ...input, hostKey: environment.hostKey });
      const result = announce(created);
      watch(created.sessionId);
      return result;
    } finally {
      starting.delete(input.sessionId);
    }
  }
  async function ensureSession(sessionId: string, parentSessionId?: string) {
    if (await binding(sessionId)) return;
    const { session } = await call<{ session?: SessionSummary }>("session.get", { id: sessionId, messageLimit: 1 });
    if (!session?.projectPath?.startsWith("remote-project:")) return;
    const { groups } = await call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
    const project = groups.find((group) => group.primaryPath === session.projectPath)?.repository;
    if (!project) return;
    const parent = parentSessionId ? await binding(parentSessionId) : null;
    await start({ sessionId, environmentId: parent?.environmentId ?? `default:${project.hostKey}`,
      repository: { owner: project.owner, name: project.name }, baseBranch: parent?.baseBranch ?? project.defaultBranch,
      ...(parent ? { fromSessionId: parent.sessionId } : {}),
    });
  }

  return {
    git, binding, update, listBindings, announce, ensureSession, list, start, recoverMissingCheckout,
    async get(sessionId: string) {
      const current = await binding(sessionId);
      return current ? publicBinding(current) : null;
    },
    async resolve(input: RemoteSessionTarget) {
      const environment = await getEnvironment(input.environmentId);
      if (!(await hosts()?.list())?.some((host) => host.hostKey === environment.hostKey && host.connected)) {
        throw remoteError(ErrorCodes.REMOTE_TARGET_HOST_OFFLINE, "The selected remote host is offline");
      }
      if (!await git().supported(environment.hostKey)) {
        throw remoteError(ErrorCodes.REMOTE_TARGET_UNSUPPORTED, "The selected host needs an update for repository sessions");
      }
      const status = await connector.status();
      if (!status.connected || status.needsReauthentication) throw remoteError(ErrorCodes.GITHUB_NOT_CONNECTED, "Connect GitHub to start a repository session");
      const { path } = await git().repository(environment.hostKey, input.repository);
      const { group, created } = await call<{ group: ProjectGroupRecord; created: boolean }>("project.group.ensureRepository", {
        hostKey: environment.hostKey, path, repository: input.repository, defaultBranch: input.defaultBranch,
      });
      if (created) emit(IPC.event.sessionsChanged, { reason: "remote.repository.project" });
      return { projectPath: group.primaryPath };
    },
    async retry(sessionId: string) {
      await jobs.get(sessionId)?.done;
      const current = await binding(sessionId);
      const isSetupFailure = current?.state === "ready" && current.setup?.status === "failed";
      if (current?.state !== "failed" && !isSetupFailure) {
        throw remoteError(ErrorCodes.CONFLICT, "Only a failed workspace can be retried");
      }
      if (!current.path) await getEnvironment(current.environmentId);
      const shouldRerunSetup = isSetupFailure || Boolean(current.path && current.setup?.status === "failed");
      if (shouldRerunSetup) rerunSetups.add(sessionId);
      try {
        return await beginPreparation(sessionId);
      } catch (error) {
        if (shouldRerunSetup) rerunSetups.delete(sessionId);
        throw error;
      }
    },
    async cancel(sessionId: string) {
      rerunSetups.delete(sessionId);
      const monitorTask = jobs.get(sessionId);
      monitorTask?.controller.abort();
      await monitorTask?.done;
      const current = await binding(sessionId);
      if (current?.jobId) {
        await git().cancelJob(current.hostKey, current.jobId).catch((error) => {
          if (remoteCode(error) !== ErrorCodes.WORKSPACE_GIT_JOB_NOT_FOUND) throw error;
        });
      }
    },
    async resume(hostKey?: string) {
      const bindings = await listBindings(["preparing", "ready"]);
      for (const current of bindings) {
        if (current.state === "preparing" && (!hostKey || current.hostKey === hostKey)) watch(current.sessionId);
      }
      const ready = bindings.filter((current) => current.state === "ready" && (!hostKey || current.hostKey === hostKey));
      if (!ready.length) return;
      const connected = hostKey ? [hostKey] : (await hosts()?.list() ?? []).filter((host) => host.connected).map((host) => host.hostKey);
      await Promise.all(connected.map(async (key) => {
        const selected = ready.filter((current) => current.hostKey === key);
        if (!selected.length) return;
        try {
          const worktrees = new Map((await git().list(key)).map((worktree) => [worktree.sessionId, worktree]));
          for (const current of selected) {
            const worktree = worktrees.get(current.sessionId);
            if (worktree) await recoverMissingCheckout(current, worktree);
          }
        } catch (error) {
          if (!offlineError(error) && remoteCode(error) !== ErrorCodes.HOST_VERSION_MISMATCH) {
            log("Could not check repository workspaces on reconnect", error);
          }
        }
      }));
    },
    async waitUntilReady(sessionId: string) {
      let current = await binding(sessionId);
      while (current?.state === "preparing" && !disposed) {
        const task = jobs.get(sessionId);
        if (!task) break;
        await task.done;
        current = await binding(sessionId);
      }
      if (current && current.state !== "ready") throw remoteError(ErrorCodes.REMOTE_WORKSPACE_NOT_READY, "Repository workspace is not ready");
    },
    async upsert(input: RemoteEnvironmentInput) {
      if (!(await hosts()?.list())?.some((host) => host.hostKey === input.hostKey)) {
        throw remoteError(ErrorCodes.REMOTE_ENVIRONMENT_NOT_FOUND, "The paired host no longer exists");
      }
      const { environment } = await call<{ environment: Omit<RemoteEnvironment, "isDefault"> }>("environments.upsert", { ...input });
      await announceEnvironments();
      return { ...environment, isDefault: environment.id === `default:${environment.hostKey}` };
    },
    async removeEnvironment(id: string) {
      const result = await call<{ ok: boolean }>("environments.remove", { id });
      await announceEnvironments();
      return result;
    },
    async removeForHost(hostKey: string) {
      await call("environments.removeForHost", { hostKey });
      await announceEnvironments();
    },
    announceEnvironments,
    dispose() {
      disposed = true;
      rerunSetups.clear();
      for (const task of jobs.values()) task.controller.abort();
    },
  };
}

export type SessionWorkspaces = ReturnType<typeof createSessionWorkspaces>;
