import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { RacpError, type Principal, type SessionSummary } from "@pi-desktop/agent-host";
import {
  collectWorkspaceDiff,
  listDir,
  readWorkspaceFile,
  toSessionSummary,
  type HostRpc,
  type HostSessionRecord,
  type RuntimeService,
} from "@pi-desktop/host-runtime";
import type { RacpHostOperations, RacpProjectCatalog, RacpSessionCatalog, RacpWorkspaceAccess } from "@pi-desktop/racp";
import type { RacpProjectSummary } from "@pi-desktop/shared";

/** A project row as host-core lists it. */
type ProjectRow = { id: number; path: string; name: string; pinned?: boolean };

/** Directory names never offered by the folder picker. */
const HIDDEN_BROWSE_NAMES = new Set([".git", "node_modules", "__pycache__", ".Trash"]);
const MAX_BROWSE_ENTRIES = 500;

function hostError(error: unknown): never {
  const code = (error as { errorCode?: string; data?: { errorCode?: string } })?.data?.errorCode ?? (error as { errorCode?: string })?.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NOT_FOUND" || code === "SESSION_NOT_FOUND") throw new RacpError("NOT_FOUND", message);
  if (code === "CONFLICT" || (code && code.startsWith("PLAN_"))) throw new RacpError("CONFLICT", message, { details: { code } });
  if (code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") throw new RacpError("INVALID_ARGUMENT", message);
  if (code === "HOST_UNAVAILABLE") throw new RacpError("AGENT_UNAVAILABLE", message, { retriable: true });
  throw new RacpError("INTERNAL", message, { details: code ? { code } : undefined });
}

function projectSummary(row: ProjectRow): RacpProjectSummary {
  return { id: String(row.id), label: row.name || basename(row.path), archived: false };
}

export type HostOperationsDeps = {
  getHost: () => HostRpc | null;
  runtime: Pick<RuntimeService, "compact" | "isBusy">;
  /** `pi-host` boots the sidecar's session cleanup on delete; the runtime link is optional at boot. */
  disposeSession?: (sessionId: string) => Promise<void>;
  revokeDevice?: (deviceId: string) => Promise<boolean>;
  /** Root the folder picker may not leave; defaults to the user's home directory. */
  browseRoot?: string;
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** Session catalog over host-core RPC. */
export function createSessionCatalog(deps: HostOperationsDeps): RacpSessionCatalog {
  const { getHost } = deps;
  async function projectPathFor(projectId: string | undefined, host: HostRpc): Promise<string | undefined> {
    if (!projectId) return undefined;
    const { projects } = await host.call<{ projects: ProjectRow[] }>("projects.list", {});
    const project = projects.find((row) => String(row.id) === projectId);
    if (!project) throw new RacpError("NOT_FOUND", `project ${projectId} is unknown`);
    return project.path;
  }
  /**
   * host-core keys a session by its project path; RACP exposes the project id
   * (spec §5.1), so the summary is decorated from the projects table. A path
   * with no row (a session whose project was removed) simply has no id.
   */
  async function withProjectIds(host: HostRpc, records: HostSessionRecord[]): Promise<SessionSummary[]> {
    const needsLookup = records.some((record) => record.projectPath);
    const byPath = new Map<string, string>();
    if (needsLookup) {
      const { projects } = await host.call<{ projects: ProjectRow[] }>("projects.list", {}).catch(hostError);
      for (const project of projects ?? []) byPath.set(project.path, String(project.id));
    }
    return records.map((record) => {
      const summary = toSessionSummary(record);
      const projectId = record.projectPath ? byPath.get(record.projectPath) : undefined;
      return projectId ? { ...summary, projectId } : summary;
    });
  }
  async function get(host: HostRpc, sessionId: string): Promise<SessionSummary> {
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(hostError);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return (await withProjectIds(host, [result.session]))[0]!;
  }
  return {
    async list() {
      const host = requireHost(getHost);
      const result = await host.call<{ sessions: HostSessionRecord[] }>("session.list", {}).catch(hostError);
      return withProjectIds(host, result.sessions ?? []);
    },
    async create(input, _principal: Principal) {
      const host = requireHost(getHost);
      const projectPath = await projectPathFor(input.projectId, host);
      const result = await host
        .call<{ session?: HostSessionRecord | null }>("session.create", {
          ...(input.title ? { title: input.title } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(projectPath ? { projectPath } : {}),
        })
        .catch(hostError);
      if (!result.session) throw new RacpError("INTERNAL", "session.create returned no session");
      if (input.permissionMode) {
        await host
          .call("session.configure", { id: result.session.id, mode: result.session.mode ?? input.mode ?? "agent", permissionMode: input.permissionMode })
          .catch(hostError);
      }
      return get(host, result.session.id);
    },
    async configure(sessionId, input) {
      const host = requireHost(getHost);
      if (deps.runtime.isBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn");
      const current = await get(host, sessionId);
      await host
        .call("session.configure", {
          id: sessionId,
          mode: input.mode ?? current.mode,
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        })
        .catch(hostError);
      return get(host, sessionId);
    },
    async fork(sessionId, input) {
      const host = requireHost(getHost);
      const result = await host
        .call<{ session?: HostSessionRecord | null }>("session.fork", {
          sessionId,
          ...(input.title ? { title: input.title } : {}),
          ...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}),
        })
        .catch(hostError);
      if (!result.session) throw new RacpError("INTERNAL", "session.fork returned no session");
      return get(host, result.session.id);
    },
    async rename(sessionId, title) {
      await requireHost(getHost).call("session.rename", { id: sessionId, title }).catch(hostError);
    },
    async delete(sessionId) {
      if (deps.runtime.isBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn");
      await requireHost(getHost).call("session.delete", { id: sessionId }).catch(hostError);
      await deps.disposeSession?.(sessionId).catch(() => undefined);
    },
    async compact(sessionId) {
      try {
        return await deps.runtime.compact(sessionId);
      } catch (error) {
        hostError(error);
      }
    },
  };
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new RacpError("INVALID_ARGUMENT", "path must be absolute");
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new RacpError("REMOTE_PATH_NOT_FOUND", `no such directory: ${path}`);
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) throw new RacpError("REMOTE_PATH_NOT_FOUND", `not a directory: ${path}`);
  return real;
}

/** Projects over host-core: registration canonicalizes on the Host (D448). */
export function createProjectCatalog(deps: HostOperationsDeps): RacpProjectCatalog {
  const { getHost } = deps;
  const browseRoot = resolve(deps.browseRoot ?? homedir());
  return {
    async list() {
      const host = requireHost(getHost);
      const result = await host.call<{ projects: ProjectRow[] }>("projects.list", {}).catch(hostError);
      return (result.projects ?? []).map(projectSummary);
    },
    async register(path) {
      const host = requireHost(getHost);
      const real = await canonicalDirectory(path);
      const result = await host.call<{ project?: ProjectRow | null }>("projects.create", { path: real }).catch(hostError);
      if (!result.project) throw new RacpError("INTERNAL", "projects.create returned no project");
      return { ...projectSummary(result.project), path: result.project.path };
    },
    async browse(path) {
      const target = path ? await canonicalDirectory(path) : browseRoot;
      const rootReal = await realpath(browseRoot).catch(() => browseRoot);
      if (target !== rootReal && !target.startsWith(rootReal.endsWith("/") ? rootReal : `${rootReal}/`)) {
        throw new RacpError("REMOTE_PATH_FORBIDDEN", "path is outside the browsable root");
      }
      const dirents = await readdir(target, { withFileTypes: true }).catch(() => {
        throw new RacpError("REMOTE_PATH_FORBIDDEN", `cannot read ${target}`);
      });
      const entries = dirents
        .filter((dirent) => dirent.isDirectory() && !HIDDEN_BROWSE_NAMES.has(dirent.name) && !dirent.name.startsWith("."))
        .map((dirent) => ({ name: dirent.name, path: join(target, dirent.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_BROWSE_ENTRIES);
      const parent = target === rootReal ? undefined : dirname(target);
      return { path: target, ...(parent ? { parent } : {}), entries };
    },
  };
}

/** Workspace reads against the session's durable root, on the Host's filesystem. */
export function createWorkspaceAccess(deps: HostOperationsDeps): RacpWorkspaceAccess {
  const { getHost } = deps;
  async function sessionRoot(sessionId: string): Promise<string> {
    const host = requireHost(getHost);
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(hostError);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    const root = result.session.projectPath?.trim();
    if (!root) throw new RacpError("CONFLICT", "the session has no project root");
    return root;
  }
  const forbidden = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (/escapes workspace root|outside allowed roots/.test(message)) throw new RacpError("REMOTE_PATH_FORBIDDEN", message);
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new RacpError("REMOTE_PATH_NOT_FOUND", message);
    if (/not a file/.test(message)) throw new RacpError("INVALID_ARGUMENT", message);
    throw new RacpError("INTERNAL", message);
  };
  return {
    async list(sessionId, path) {
      const root = await sessionRoot(sessionId);
      return { entries: await listDir(root, path).catch(forbidden) };
    },
    async read(sessionId, path) {
      const root = await sessionRoot(sessionId);
      return readWorkspaceFile(root, path).catch(forbidden);
    },
    async diff(sessionId) {
      return collectWorkspaceDiff(await sessionRoot(sessionId));
    },
  };
}

export function createHostOperations(deps: HostOperationsDeps): Omit<RacpHostOperations, "terminal"> {
  return {
    sessions: createSessionCatalog(deps),
    projects: createProjectCatalog(deps),
    workspace: createWorkspaceAccess(deps),
    ...(deps.revokeDevice ? { revokeDevice: deps.revokeDevice } : {}),
  };
}
