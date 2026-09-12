import { IPC, type AgentEventEnvelope, type UiMessage } from "@pi-desktop/shared";
import {
  genericModelConfig,
  loadInstructionChain,
  modelConfigWithBinding,
} from "@pi-desktop/agent-runtime";
import { loadBuiltinSkillBody } from "../builtin-skills";
import { registerPluginDevTools } from "../plugin-dev-tools";
import { resolveLocalFile } from "../browser-view";
import { modelConfigFromModelsDev } from "../models-dev-catalog";
import { AgentSidecar } from "../agent-sidecar";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { BrowserHost } from "../browser-host";
import type { InflightCheckpointer } from "../inflight-checkpoint";
import type { Logger } from "../logger";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import type { PluginRuntime } from "../plugin-runtime";
import type { UserMcpRuntime } from "../user-mcp";
import type { RuntimeState } from "./context";

export type SidecarRuntimeDependencies = {
  runtimeState: RuntimeState;
  logger: Logger;
  sendToRenderer: (channel: string, payload: unknown) => void;
  persistAgentEvent: (envelope: AgentEventEnvelope) => UiMessage | undefined;
  activeTurns: Map<string, string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  inflightCheckpointer: InflightCheckpointer;
  finishTurn: (...args: any[]) => Promise<void>;
  finishApprovedExecution: (...args: any[]) => Promise<void>;
  superviseRestart: (kind: "host" | "sidecar") => Promise<void>;
  isQuitting: () => boolean;
  dataDir: string;
  agentExtensions: AgentExtensionBridge;
  vendorOAuth: VendorOAuth;
  listRuntimeProviders: (includeDisabled?: boolean) => Promise<any[]>;
  modelsDevCatalog: ModelsDevCatalog;
  effectiveSubagentModelConfig: (...args: any[]) => any;
  browserHost: BrowserHost;
  plugins: PluginRuntime;
  sessionProjects: Map<string, string | null>;
  loadUserSkillBody: (id: string, projectPath: string | null) => Promise<any>;
  activeUserSkills: (projectPath: string | undefined) => Promise<any[]>;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  currentNetworkProxy: () => any;
};

export function createSidecarRuntime({
  runtimeState,
  logger,
  sendToRenderer,
  persistAgentEvent,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  inflightCheckpointer,
  finishTurn,
  finishApprovedExecution,
  superviseRestart,
  isQuitting,
  dataDir,
  agentExtensions,
  vendorOAuth,
  listRuntimeProviders,
  modelsDevCatalog,
  effectiveSubagentModelConfig,
  browserHost,
  plugins,
  sessionProjects,
  loadUserSkillBody,
  activeUserSkills,
  pluginActiveInProject,
  currentNetworkProxy,
}: SidecarRuntimeDependencies): {
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  wireSidecar: (sidecar: AgentSidecar) => void;
  startSidecar: () => Promise<void>;
} {
  const emitAgentEvent = (envelope: AgentEventEnvelope) => {
    runtimeState.agentHostBridge?.ingest(envelope);
    sendToRenderer(IPC.event.agentMessage, envelope);
  };
  const wireSidecar = (s: AgentSidecar) => {

  s.onNotification((method, params) => {
    if (method === "agent.event") {
      const envelope = params as AgentEventEnvelope;
      const event = envelope.event;
      if (event.type === "tool_start") {
        logger.app("tool", "info", "tool start", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: { toolName: (event as any).toolName },
        });
      } else if (event.type === "tool_end") {
        logger.app("tool", "info", "tool end", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: { isError: (event as any).isError === true },
        });
      }
      emitAgentEvent(envelope);
      const persistedMessage = persistAgentEvent(envelope);
      if (persistedMessage) {
        // The renderer may have reloaded while a long-running tool was open.
        // Replay the completed row through the existing message_end contract so
        // it can append the row when the original tool_start is no longer in
        // the in-memory transcript.
        emitAgentEvent({
          ...envelope,
          event: { type: "message_end", message: persistedMessage },
        } satisfies AgentEventEnvelope);
      }
    }
    // permissions.request reaches the renderer once, via wireHost; the
    // sidecar no longer relays it (agent-sidecar.setHost filters it out).
  });
  s.onExit(({ code, signal, intentional, stderrTail }) => {
    if (runtimeState.sidecar !== s) return;
    logger.flushChild("agent");
    runtimeState.sidecar = null;
    if (intentional || isQuitting()) return;
    // A sidecar crash closes live approval waiters before the replacement
    // sidecar starts. This prevents an old renderer response from waking a
    // dead runtime and records the durable turn as interrupted.
    for (const sessionId of [...activeTurns.keys()]) {
      void (async () => {
        const executionId = approvedExecutionIdsBySession.get(sessionId);
        if (runtimeState.host) {
          await runtimeState.host.call("plans.abort", { sessionId }).catch(() => undefined);
        }
        // No final row is coming from a dead sidecar: keep whatever the reply
        // had streamed so far as an aborted transcript row (D299).
        await inflightCheckpointer.flush(sessionId);
        inflightCheckpointer.settle(sessionId);
        await finishTurn(sessionId, "aborted", "PLAN_APPROVAL_INTERRUPTED", {
          recoverInflight: true,
        });
        if (executionId) {
          await finishApprovedExecution(
            executionId,
            "interrupted",
            "PLAN_EXECUTION_INTERRUPTED",
          );
        }
      })();
    }
    for (const [executionId] of claimedExecutionSessions) {
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    logger.app("runtime", "error", "agent sidecar exited unexpectedly", {
      data: { exitCode: code, signal, stderrTail },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "sidecar",
      restarting: true,
    });
    void superviseRestart("sidecar");
  });
  };
  const startSidecar = async (): Promise<void> => {

  const s = new AgentSidecar((text) => logger.child("agent", text));
  wireSidecar(s);
  s.setProjectInstructionResolver(async ({ projectPath, path }) => {
    // The root is registered by Electron main from the host-owned session
    // record. The sidecar can provide a target path, never an arbitrary root.
    return loadInstructionChain(projectPath, path);
  });
    // Request auth for a vendor account (ADR 0098). The sidecar names a provider
  // row it was launched with; main resolves that row's account and returns a
  // short-lived `ModelAuth`. The refresh token never crosses this boundary.
  s.setTrustedExtensionBridge({
    publishCommands: (params) =>
      agentExtensions.publishCommands(
        String(params.sessionId ?? ""),
        Array.isArray(params.commands) ? (params.commands as any[]) : [],
      ),
    publishDiagnostics: (params) =>
      agentExtensions.publishDiagnostics(
        String(params.sessionId ?? ""),
        Array.isArray(params.diagnostics) ? (params.diagnostics as any[]) : [],
        Array.isArray(params.reports) ? (params.reports as any[]) : [],
      ),
    requestUi: (params) => agentExtensions.requestUi(params as any),
    queuePush: async (params) => {
      if (!runtimeState.agentHostBridge) throw new Error("agent host unavailable");
      return runtimeState.agentHostBridge.queue.push({
        sessionId: String(params.sessionId ?? ""),
        content: String(params.content ?? ""),
        ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}),
      });
    },
    queuePrioritize: async (params) => {
      if (!runtimeState.agentHostBridge) throw new Error("agent host unavailable");
      await runtimeState.agentHostBridge.queue.prioritize(String(params.id ?? ""));
      return { ok: true };
    },
  });
  s.setVendorAuthResolver(async ({ providerId }) =>
    vendorOAuth.resolveAuth(providerId),
  );
  s.setSubagentModelResolver(async (key: string) => {
    const slash = key.indexOf("/");
    if (slash < 1) throw new Error("invalid model key");
    const providerPart = key.slice(0, slash);
    const modelId = key.slice(slash + 1);
    if (!modelId) throw new Error("empty model id");

    const allProviders = await listRuntimeProviders(false);
    // Use the same matching logic as resolveSubagentProviders
    const alias = providerPart.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const provider =
      allProviders.find((p) => p.id === providerPart) ||
      allProviders.filter((p) => (p.vendorKey ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === alias)[0] ||
      allProviders.filter((p) => p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === alias)[0];
    if (!provider) throw new Error(`no provider matches "${providerPart}"`);

    // Check if the model has availableForSubagents enabled
    const binding = provider.models?.find(
      (m: any) => m.id === modelId || m.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (!binding?.availableForSubagents) {
      throw new Error(
        `model "${modelId}" on provider "${provider.name}" is not enabled for delegation`,
      );
    }

    const isVendorAccount = provider.authKind === OAUTH_AUTH_KIND;
    let apiKey = "";
    if (!isVendorAccount && provider.authKind !== "none") {
      const secret = await runtimeState.host!.call<{ value?: string }>(
        "providers.getSecret",
        { id: provider.id },
      );
      apiKey = secret?.value ?? "";
      if (!apiKey) throw new Error(`provider "${provider.name}" has no API key`);
    }

    await modelsDevCatalog.ensureLoaded();
    let catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0];
    if (isVendorAccount) {
      const vendorBinding = await vendorOAuth.bindingFor(provider.id, modelId);
      if (!vendorBinding) throw new Error(`vendor "${provider.name}" does not offer "${modelId}"`);
      catalogModelConfig =
        vendorBinding.modelConfig ??
        genericModelConfig(modelId, vendorBinding.baseUrl ?? provider.baseUrl ?? "");
    } else {
      const model = modelsDevCatalog.findModel({
        vendorKey: provider.vendorKey,
        baseUrl: provider.baseUrl,
        modelId,
      });
      catalogModelConfig = model
        ? modelConfigFromModelsDev(model, provider.baseUrl)
        : genericModelConfig(modelId, provider.baseUrl ?? "");
    }
    const { modelConfig, capabilities } = effectiveSubagentModelConfig(
      provider,
      modelId,
      catalogModelConfig,
    );

    return {
      id: provider.id,
      name: provider.name,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      modelId,
      apiKey,
      ...(provider.authKind ? { authKind: provider.authKind } : {}),
      ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
      supportsReasoning: capabilities.supportsReasoning,
      supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
      ...(modelConfig ? { modelConfig } : {}),
    };
  });
  // Agent-driven work panel preview (D100): open a workspace HTML file in
  // the embedded browser; live reload keeps it current through later edits.
  s.setLocalTool("BrowserPreview", async ({ args, sessionId }) => {
    const raw = String((args as { path?: unknown })?.path ?? "").trim();
    if (!raw) {
      return {
        ok: false,
        isError: true,
        content: "BrowserPreview: `path` is required.",
      };
    }
    let root: string | null = null;
    try {
      const res = (await runtimeState.host?.call("session.get", { id: sessionId })) as
        | { session: { projectPath?: string } | null }
        | undefined;
      root = res?.session?.projectPath?.trim() || null;
    } catch {
      root = null;
    }
    if (!root) {
      return {
        ok: false,
        isError: true,
        content: "BrowserPreview: no workspace is open.",
      };
    }
    if (!resolveLocalFile(raw, root)) {
      return {
        ok: false,
        isError: true,
        content: `BrowserPreview: "${raw}" does not resolve to an existing file inside the workspace.`,
      };
    }
    const preview = await browserHost.previewWorkspaceFile(sessionId, raw, root);
    if (!preview.ok) {
      return {
        ok: false,
        isError: true,
        content: preview.content,
      };
    }
    sendToRenderer(IPC.event.browserPreview, {
      sessionId,
      path: raw,
    });
    return {
      ok: true,
      content: `Previewing ${raw} in the work-panel Browser plugin. Live reload is active — subsequent edits to the file or sibling assets re-render automatically.`,
    };
  });
  // Plugin skills (D174): the model loads a declared skill document by id.
  // Served in main because the plugin runtime — and the plugin directories —
  // live here, not in host-core.
  s.setLocalTool("Skill", async ({ args, sessionId }) => {
    const id = String((args as { id?: unknown })?.id ?? "").trim();
    if (!id) {
      return {
        ok: false,
        isError: true,
        content: "Skill: `id` is required. Use an id from the Skills section.",
      };
    }
    const projectPath = sessionProjects.get(sessionId) ?? null;
    try {
      // Bundled skills answer first; they are not owned by any plugin. A user
      // skill is looked up next, and only then a plugin's — the ids cannot
      // collide, since a plugin skill id always carries a `<pluginId>/` prefix.
      const skill =
        loadBuiltinSkillBody(id) ??
        (await loadUserSkillBody(id, projectPath)) ??
        plugins.loadSkillBody(id);
      return {
        ok: true,
        content: `# Skill: ${skill.name} (${skill.id})\n\n${skill.body}`,
      };
    } catch (error) {
      const userIds = (await activeUserSkills(projectPath ?? undefined)).map(
        (skill) => skill.id,
      );
      const pluginIds = plugins
        .getSkills()
        .filter((skill) => pluginActiveInProject(skill.pluginId, projectPath))
        .map((skill) => skill.id);
      const available = [...userIds, ...pluginIds].join(", ");
      return {
        ok: false,
        isError: true,
        content: `Skill: ${error instanceof Error ? error.message : String(error)}.${
          available ? ` Available skills: ${available}.` : ""
        }`,
      };
    }
  });
  // Plugin authoring (D171): scaffold, validate and package a plugin without
  // leaving the session. Paths stay inside the open workspace.
  registerPluginDevTools(s, {
    resolveWorkspace: async (sessionId) => {
      try {
        const res = (await runtimeState.host?.call("session.get", { id: sessionId })) as
          | { session: { projectPath?: string } | null }
          | undefined;
        return res?.session?.projectPath?.trim() || null;
      } catch {
        return null;
      }
    },
    registerDevPlugin: async (path) => {
      if (!runtimeState.host) throw new Error("host unavailable");
      const loaded = await runtimeState.host.call<{ plugin?: { permissions?: string[] } }>(
        "plugins.loadDev",
        { path },
      );
      return loaded.plugin?.permissions ?? [];
    },
    loadPlugin: async (path, permissions) => {
      const manifest = await plugins.loadFromPath(path, permissions ?? [], {
        development: true,
      });
      plugins.watchDevPlugin(manifest.id);
      for (const toast of plugins.drainToasts()) {
        sendToRenderer(IPC.event.toast, { message: toast });
      }
      sendToRenderer(IPC.event.pluginChanged,{ reason: "scaffold" });
    },
  });
  runtimeState.sidecar = s;
  if (runtimeState.host) s.setHost(runtimeState.host);
  await s.call("sidecar.configure", {
    hostBinary: runtimeState.host?.binaryPath,
    dataDir,
    networkProxy: currentNetworkProxy(),
  });
  logger.app("runtime", "info", "agent sidecar configured");
  };
  return { emitAgentEvent, wireSidecar, startSidecar };
}
