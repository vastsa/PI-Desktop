import { shell } from "electron";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ErrorCodes,
  IPC,
  modelConfigImportKey,
  publicModelConfigCandidate,
  draftMatchesExisting,
  providerCreateInputFromDraft,
  isModelConfigImportSource,
  type ActivationScope,
  type ModelConfigImportDraft,
  type Mode,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import {
  convertSession,
  scanAllSources,
  scanModelConfigs,
  type ExternalSessionSummary,
  type ExternalSource,
} from "../importers";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import type { IpcRegistrar } from "./types";

type RuntimeSession = {
  id?: string;
  projectPath?: string | null;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  [key: string]: unknown;
};

type ImportableModelConfig = ModelConfigImportDraft & {
  id?: string;
  secretValue?: string;
};

let scannedImportSessions = new Map<string, ExternalSessionSummary>();
let scannedModelConfigs = new Map<string, ModelConfigImportDraft>();

const IMPORT_SOURCES = new Set<ExternalSource>([
  "claude-code",
  "opencode",
  "codex",
  "pi",
]);

function importSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    typeof source !== "string" ||
    !IMPORT_SOURCES.has(source as ExternalSource) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return `${source}:${externalId}`;
}

function modelConfigSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    !isModelConfigImportSource(source) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return modelConfigImportKey(source, externalId);
}

export type SessionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  activeTurns: ReadonlyMap<string, string>;
  sessionProjects: Map<string, string | null>;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
  plugins: Pick<PluginRuntime, "broadcastEvent">;
  sessionCapabilityContext: () => Promise<{ providers: any; defaults: any }>;
  enrichSession: (session: any, providers: any, defaults: any) => any;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  stripWinLongPrefix: (path: string) => string;
};

export function registerSessionIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  activeTurns,
  sessionProjects,
  persistenceOutbox,
  logger,
  plugins,
  sessionCapabilityContext,
  enrichSession,
  acquireSessionOperation,
  stripWinLongPrefix,
}: SessionIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.sessionList, async () => {
    if (!host) throw new Error("host unavailable");
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ sessions: RuntimeSession[] }>("session.list"),
      sessionCapabilityContext(),
    ]);
    return {
      ...result,
      sessions: result.sessions.map((session) =>
        enrichSession(session, providers, defaults),
      ),
    };
  });
  handle(IPC.invoke.sessionCreate, async (input = {}) => {
    if (!host) throw new Error("host unavailable");
    const capabilityPromise = sessionCapabilityContext();
    const res = await host.call<{ session?: (RuntimeSession & { id?: string }) | null }>(
      "session.create",
      input,
    );
    logger.app("session", "info", "session created", { sessionId: res.session?.id });
    if (!res.session) return res;
    const { providers, defaults } = await capabilityPromise;
    return { ...res, session: enrichSession(res.session, providers, defaults) };
  });
  handle(
    IPC.invoke.sessionFork,
    async (
      input: { sessionId?: string; title?: string; throughMessageId?: string } = {},
    ) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot fork a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      // Resolve enrichment before the mutation so a provider-list failure
      // cannot report a failed IPC after the child has already been committed.
      const { providers, defaults } = await sessionCapabilityContext();
      let result: { session?: RuntimeSession | null };
      try {
        result = await host.call("session.fork", {
          sessionId,
          title: String(input.title ?? "").trim() || undefined,
          throughMessageId:
            String(input.throughMessageId ?? "").trim() || undefined,
        });
      } catch (error: any) {
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot fork a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      logger.app("session", "info", "session forked", {
        sessionId: (result.session as { id?: string }).id,
        data: { sourceSessionId: sessionId },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
    },
  );
  handle(
    IPC.invoke.sessionGet,
    async (
      input:
        | string
        | {
            id?: string;
            messageBefore?: number;
            messageLimit?: number;
            contentLimit?: number;
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof input === "string" ? { id: input } : input ?? {};
      const id = String(request.id ?? "").trim();
      if (!id) throw new Error("session id required");
      const [result, { providers, defaults }] = await Promise.all([
        host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          ...(Number.isInteger(request.messageBefore) && request.messageBefore! >= 0
            ? { messageBefore: request.messageBefore }
            : {}),
          ...(Number.isInteger(request.messageLimit) && request.messageLimit! > 0
            ? { messageLimit: request.messageLimit }
            : {}),
          ...(Number.isInteger(request.contentLimit) && request.contentLimit! > 0
            ? { contentLimit: request.contentLimit }
            : {}),
        }),
        sessionCapabilityContext(),
      ]);
      return result.session
        ? { ...result, session: enrichSession(result.session, providers, defaults) }
        : result;
    },
  );
  handle(IPC.invoke.sessionOpen, async (rawSessionId: string) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = String(rawSessionId ?? "").trim();
    if (!sessionId) throw new Error("session id required");
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ session?: RuntimeSession | null }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      }),
      sessionCapabilityContext(),
    ]);
    if (!result.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return { ...result, session: enrichSession(result.session, providers, defaults) };
  });
  handle(IPC.invoke.sessionDelete, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("session.delete", { id });
    await persistenceOutbox.dropSession(id);
    // Drop the session's pi-agent so a later session with the same id (or a
    // stale runtime) can't answer with this session's context.
    if (sidecar) {
      sidecar.clearProjectInstructionRoot(id);
      sidecar.clearVendorAuthBindings(id);
      await sidecar
        .call("agent.disposeSession", { sessionId: id })
        .catch(() => undefined);
    }
    sessionProjects.delete(id);
    logger.app("session", "info", "session deleted", { sessionId: id });
    return res;
  });
  handle(IPC.invoke.sessionRename, async (id: string, title: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("session.rename", { id, title });
  });
  handle(
    IPC.invoke.sessionMoveProject,
    async (input: { sessionId?: string; projectPath?: string } = {}) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      const projectPath = String(input.projectPath ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!projectPath) {
        throw Object.assign(new Error("projectPath required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const releaseSessionOperation = await acquireSessionOperation(sessionId);
      try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot move a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      let result: { session?: (RuntimeSession & { projectPath?: string | null }) | null };
      try {
        result = await host.call("session.moveProject", { sessionId, projectPath });
      } catch (error: any) {
        // The durable running-turn guard can still reject a session whose turn
        // began between the check above and the host call.
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot move a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      const movedProjectPath = result.session.projectPath?.trim() || null;
      sessionProjects.set(sessionId, movedProjectPath);
      // The live pi-agent caches the project instruction root and vendor auth
      // bindings. Drop it after a successful move so the next turn is rebuilt
      // from the moved session's own project instead of the previous one.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
        if (movedProjectPath) {
          sidecar.setProjectInstructionRoot(sessionId, movedProjectPath);
        }
      }
      const { providers, defaults } = await sessionCapabilityContext();
      logger.app("session", "info", "session project moved", {
        sessionId,
        data: { projectPath: movedProjectPath },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
      } finally {
        releaseSessionOperation();
      }
    },
  );
  handle(
    IPC.invoke.sessionReplaceMessages,
    async (input: { sessionId: string; messages: unknown[] }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      // Drop the live pi-agent so the next prompt reseeds from the truncated
      // transcript instead of replaying the discarded branch in memory.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.replaceMessages", {
        sessionId,
        messages: input.messages ?? [],
      });
    },
  );
  handle(
    IPC.invoke.sessionSaveRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      messages: unknown[];
      makeActive?: boolean;
    }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("session.saveRevision", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
        messages: input?.messages ?? [],
        makeActive: input?.makeActive === true,
      });
    },
  );
  handle(
    IPC.invoke.sessionListRevisions,
    async (input: { sessionId: string; rootUserId: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("session.listRevisions", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
      });
    },
  );
  handle(
    IPC.invoke.sessionActivateRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      revisionIndex: number;
      prefix?: unknown[];
    }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.activateRevision", {
        sessionId,
        rootUserId: String(input?.rootUserId || ""),
        revisionIndex: Number(input?.revisionIndex || 0),
        prefix: input?.prefix ?? [],
      });
    },
  );
  handle(IPC.invoke.sessionGetScratchPath, async (input: { sessionId: string }) => {
    if (!host) throw new Error("host unavailable");
    return host.call<{ path: string }>("session.getScratchPath", {
      sessionId: String(input?.sessionId || ""),
    });
  });
  handle(IPC.invoke.sessionOpenScratchPath, async (input: { sessionId: string }) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = String(input?.sessionId || "").trim();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId,
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("invalid session id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    mkdirSync(scratchPath, { recursive: true });
    const openError = await shell.openPath(stripWinLongPrefix(scratchPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: scratchPath };
  });
  handle(
    IPC.invoke.sessionConfigure,
    async (
      id: string,
      config: {
        mode: Mode;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: ThinkingLevel;
        permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
      },
    ) => {
      if (!host) throw new Error("host unavailable");
      const result = await host.call<{ session?: RuntimeSession | null }>(
        "session.configure",
        { id, ...config },
      );
      if (!result.session) return result;
      const { providers, defaults } = await sessionCapabilityContext();
      const session = enrichSession(result.session, providers, defaults);
      if (
        config.providerId !== undefined ||
        config.modelId !== undefined ||
        config.thinkingLevel !== undefined
      ) {
        const modelKey =
          session.providerId && session.modelId
            ? `${session.providerId}/${session.modelId}`
            : null;
        plugins.broadcastEvent("session:modelChanged", [
          {
            sessionId: id,
            modelKey,
            thinkingLevel: session.thinkingLevel,
          },
        ]);
      }
      return { ...result, session };
    },
  );

  handle(IPC.invoke.sessionImportScan, async () => {
    const sessions = await scanAllSources();
    scannedImportSessions = new Map(
      sessions.map((session) => [`${session.source}:${session.externalId}`, session]),
    );
    return {
      sessions: sessions.map(({ filePath: _filePath, ...candidate }) => candidate),
    };
  });
  handle(
    IPC.invoke.sessionImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      for (const selection of items) {
        const key = importSelectionKey(selection);
        const item = key ? scannedImportSessions.get(key) : undefined;
        if (!item) {
          failed += 1;
          logger.app("session", "warn", "session import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        try {
          const converted = await convertSession(item);
          const res = await host.call<{ imported?: boolean }>("session.import", {
            session: converted.session,
            messages: converted.messages,
          });
          if (res.imported) imported += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logger.app("session", "warn", "session import failed", {
            data: { source: item?.source, externalId: item?.externalId, error: String(e) },
          });
        }
      }
      logger.app("session", "info", "session import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  handle(IPC.invoke.modelConfigImportScan, async () => {
    const drafts = await scanModelConfigs();
    scannedModelConfigs = new Map(
      drafts.map((draft) => [modelConfigImportKey(draft.source, draft.externalId), draft]),
    );
    return { providers: drafts.map(publicModelConfigCandidate) };
  });
  handle(
    IPC.invoke.modelConfigImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const existing = await host.call<{
        providers: Array<{
          id: string;
          baseUrl?: string | null;
          apiStyle?: string | null;
          vendorKey?: string | null;
          hasSecret?: boolean;
        }>;
      }>("providers.list", { includeDisabled: true });
      // Matching an import by endpoint alone collapses distinct credentials.
      // Resolve existing API keys in Electron main so same-endpoint profiles
      // remain independent without exposing secrets to the renderer.
      const known = await Promise.all(
        (existing.providers ?? []).map(async (provider) => {
          let secretValue: string | undefined;
          if (provider.hasSecret) {
            try {
              secretValue = (
                await host!.call<{ value?: string }>("providers.getSecret", {
                  id: provider.id,
                })
              ).value;
            } catch {
              // A provider may only have an OAuth credential, or its secret
              // backend may be temporarily unavailable. In either case,
              // failing closed here avoids collapsing a new profile.
            }
          }
          return { ...provider, secretValue };
        }),
      );
      let firstImported:
        | { id: string; defaultModelId?: string; models?: Array<{ id: string }> }
        | undefined;
      for (const selection of items) {
        const key = modelConfigSelectionKey(selection);
        const draft = key ? scannedModelConfigs.get(key) : undefined;
        if (!draft) {
          failed += 1;
          logger.app("provider", "warn", "model config import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        if (draftMatchesExisting(draft, known)) {
          skipped += 1;
          continue;
        }
        try {
          const created = await host.call<{
            provider: { id: string; defaultModelId?: string; models?: Array<{ id: string }> };
          }>("providers.create", providerCreateInputFromDraft(draft));
          imported += 1;
          known.push({
            ...draft,
            id: created.provider.id,
            secretValue: draft.secretValue,
          });
          firstImported ??= created.provider;
        } catch (e) {
          failed += 1;
          logger.app("provider", "warn", "model config import failed", {
            data: {
              source: draft.source,
              externalId: draft.externalId,
              name: draft.name,
              hasSecret: draft.hasSecret,
              error: String(e),
            },
          });
        }
      }
      if (firstImported) {
        try {
          const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
          if (!settings?.defaultProviderId) {
            await host.call("settings.set", {
              defaultProviderId: firstImported.id,
              defaultModelId:
                firstImported.models?.[0]?.id ?? firstImported.defaultModelId,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model config import default not set", {
            data: { error: String(e) },
          });
        }
      }
      logger.app("provider", "info", "model config import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

}
