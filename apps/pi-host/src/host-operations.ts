import { createWorkspaceFiles } from "./workspace-files.js";
import { createWorkspacePluginFiles } from "./plugin-workspace-files.js";
import { createWorkspaceTools } from "./workspace-tools.js";
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
import type {
  HostModelCatalog,
  HostModelRow,
  HostSessionUsage,
  RacpHostOperations,
  RacpModelCatalog,
  RacpProjectCatalog,
  RacpSessionCatalog,
  RacpUsageReport,
  RacpWorkspaceAccess,
} from "@pi-desktop/racp";
import type { RacpProjectSummary } from "@pi-desktop/shared";

/** A project row as host-core lists it. */
type ProjectRow = { id: number; path: string; name: string; pinned?: boolean };

/** One selected model inside a provider row, as `providers.list` reports it. */
type ProviderModelRow = {
  id: string;
  alias?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string | null;
  fastModeAllowed?: boolean;
};

/** A provider row reduced to what a model catalog may publish. */
type ProviderRow = {
  id: string;
  name: string;
  enabled?: boolean;
  hasSecret?: boolean;
  authKind?: string;
  models?: ProviderModelRow[];
  defaultModelId?: string;
  contextWindow?: number;
  supportedThinkingLevels?: string[];
};

/** One published catalog record, used only to enrich a selected model. */
type PublishedModelRow = {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities?: string[];
  contextWindow?: number;
};

/** `session.turnUsage` as host-core reports the newest physical request. */
type HostTurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerId?: string | null;
  modelId?: string | null;
};

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

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
  /** Host credentials and persistence must never be exposed through plugin reads. */
  dataDir?: string;
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
    async deriveTitle(sessionId, title) {
      const result = await requireHost(getHost)
        .call<{ updated?: boolean }>("session.deriveTitle", { id: sessionId, title })
        .catch(hostError);
      return result.updated === true;
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
      const target = await canonicalDirectory(path ?? browseRoot);
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

/**
 * The models this Host can actually run, published for a paired client's
 * Composer. Rows mirror what the Host's own Settings offers: enabled providers
 * with a usable credential, and the models selected in each of them. Only
 * public catalog metadata crosses the boundary — no endpoint, header, or
 * secret (spec §5.2).
 */
export function createModelCatalog(deps: HostOperationsDeps): RacpModelCatalog {
  return {
    async list(): Promise<HostModelCatalog> {
      const host = requireHost(deps.getHost);
      const [providers, published, settings] = await Promise.all([
        host.call<{ providers?: ProviderRow[] }>("providers.list", { includeDisabled: false }).catch(hostError),
        host.call<{ models?: PublishedModelRow[] }>("providers.listModels", {}).catch(hostError),
        host.call<{ defaultProviderId?: string; defaultModelId?: string }>("settings.get", {}).catch(hostError),
      ]);
      const known = new Map(
        (published.models ?? []).map((item) => [`${item.providerId}\u0000${item.modelId}`, item]),
      );
      const models: HostModelRow[] = [];
      for (const provider of providers.providers ?? []) {
        if (provider.enabled === false) continue;
        if (provider.hasSecret === false && provider.authKind !== "none") continue;
        for (const model of provider.models ?? []) {
          const modelId = model.id?.trim();
          if (!modelId) continue;
          const catalog = known.get(`${provider.id}\u0000${modelId}`);
          const contextWindow = tokenCount(model.contextWindow)
            || tokenCount(provider.contextWindow)
            || tokenCount(catalog?.contextWindow);
          const levels = model.thinkingLevels?.length
            ? model.thinkingLevels
            : provider.supportedThinkingLevels;
          models.push({
            providerId: provider.id,
            providerName: provider.name,
            modelId,
            displayName: model.alias?.trim() || catalog?.displayName || modelId,
            ...(contextWindow > 0 ? { contextWindow } : {}),
            ...(catalog?.capabilities?.length ? { capabilities: [...catalog.capabilities] } : {}),
            ...(levels?.length ? { supportedThinkingLevels: [...levels] } : {}),
            ...(model.fastModeAllowed === true ? { fastMode: true } : {}),
          });
        }
      }
      return {
        models,
        ...(settings.defaultProviderId ? { defaultProviderId: settings.defaultProviderId } : {}),
        ...(settings.defaultModelId ? { defaultModelId: settings.defaultModelId } : {}),
      };
    },
  };
}

/**
 * The session's newest physical request, which is the only figure that can
 * answer "how much context is left": the paired Desktop cannot read the Host's
 * turn ledger, and transcript messages carry usage only for nested tool
 * operations, never the top-level assistant row.
 */
export function createUsageReport(deps: HostOperationsDeps): RacpUsageReport {
  return {
    async read(sessionId: string): Promise<HostSessionUsage> {
      const host = requireHost(deps.getHost);
      const result = await host.call<{ usage?: HostTurnUsage | null }>("session.turnUsage", { id: sessionId }).catch(hostError);
      const usage = result.usage;
      if (!usage) return {};
      const providerId = usage.providerId ?? undefined;
      const modelId = usage.modelId ?? undefined;
      // The window is a catalog fact, so it travels with the usage rather than
      // making every client resolve the Host's provider bindings itself.
      const catalog = await createModelCatalog(deps)
        .list()
        .catch((): HostModelCatalog => ({ models: [] }));
      const row = catalog.models.find(
        (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
      );
      return {
        usage: {
          inputTokens: tokenCount(usage.inputTokens),
          outputTokens: tokenCount(usage.outputTokens),
          ...(usage.cacheReadTokens ? { cacheReadTokens: tokenCount(usage.cacheReadTokens) } : {}),
          ...(usage.cacheWriteTokens ? { cacheWriteTokens: tokenCount(usage.cacheWriteTokens) } : {}),
          ...(usage.reasoningTokens ? { reasoningTokens: tokenCount(usage.reasoningTokens) } : {}),
          totalTokens: tokenCount(usage.totalTokens),
        },
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(row?.contextWindow ? { contextWindow: row.contextWindow } : {}),
      };
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
    models: createModelCatalog(deps),
    usage: createUsageReport(deps),
    projects: createProjectCatalog(deps),
    workspace: createWorkspaceAccess(deps),
    workspaceTools: createWorkspaceTools(deps.getHost),
    workspaceFiles: createWorkspaceFiles(),
    workspacePluginFiles: createWorkspacePluginFiles({
      browseRoot: deps.browseRoot ?? homedir(),
      protectedPaths: [deps.dataDir ?? join(homedir(), ".pi-desktop")],
      isRegisteredRoot: async (root) => {
        const host = requireHost(deps.getHost);
        const result = await host.call<{ projects: ProjectRow[] }>("projects.list", {}).catch(hostError);
        return (result.projects ?? []).some((project) => project.path === root);
      },
    }),
    ...(deps.revokeDevice ? { revokeDevice: deps.revokeDevice } : {}),
  };
}
