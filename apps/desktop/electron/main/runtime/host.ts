import { ErrorCodes, IPC, type AgentEventEnvelope } from "@pi-desktop/shared";
import { assertLinuxGlibcSupported } from "../linux-glibc";
import { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import type { UserMcpRuntime } from "../user-mcp";
import type { RuntimeState } from "./context";

export type HostRuntimeDependencies = {
  runtimeState: RuntimeState;
  dataDir: string;
  logger: Logger;
  persistenceOutbox: PersistenceOutbox;
  activeToolCalls: Map<string, any>;
  activeToolCallKey: (sessionId: string, toolCallId: string) => string;
  sessionProjects: Map<string, string | null>;
  plugins: PluginRuntime;
  userMcp: UserMcpRuntime;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  sendToRenderer: (channel: string, payload: unknown) => void;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  togglePluginLauncher: () => Promise<void>;
  finishTurn: (...args: any[]) => Promise<void>;
  finishApprovedExecution: (...args: any[]) => Promise<void>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  importLegacyScheduled: () => Promise<unknown>;
  superviseRestart: (kind: "host" | "sidecar") => Promise<void>;
  isQuitting: () => boolean;
};

export function createHostRuntime({
  runtimeState,
  dataDir,
  logger,
  persistenceOutbox,
  activeToolCalls,
  activeToolCallKey,
  sessionProjects,
  plugins,
  userMcp,
  pluginActiveInProject,
  sendToRenderer,
  emitAgentEvent,
  togglePluginLauncher,
  finishTurn,
  finishApprovedExecution,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting,
}: HostRuntimeDependencies): {
  wireHost: (host: HostProcess) => void;
  startHost: () => Promise<void>;
} {
  const wireHost = (h: HostProcess) => {

  h.onNotification((method, params) => {
    // Notifications from a previous host generation must never reach the
    // current plugin/renderer bridge after a restart.
    if (runtimeState.host !== h) return;
    if (method === "permissions.request") {
      logger.app("permission", "info", "permission requested", {
        sessionId: (params as any).sessionId,
        toolCallId: (params as any).toolCallId,
        data: { toolName: (params as any).toolName, risk: (params as any).risk },
      });
      // A delegate's call is already in `activeToolCalls` by the time the host
      // asks: the sidecar forwards `tool_start` before it executes the tool.
      // Without this the dialog would attribute a delegate's write to the main
      // agent, which is the one thing the user must not be confused about.
      const asking = activeToolCalls.get(
        activeToolCallKey(
          (params as any).sessionId,
          (params as any).toolCallId,
        ),
      );
      const envelope: AgentEventEnvelope = {
        sessionId: (params as any).sessionId,
        ts: Date.now(),
        event: {
          type: "tool_permission_request",
          request: {
            requestId: (params as any).requestId,
            sessionId: (params as any).sessionId,
            toolCallId: (params as any).toolCallId,
            toolName: (params as any).toolName,
            argsPreview: (params as any).argsPreview,
            risk: (params as any).risk,
            reason: (params as any).reason,
            ...(asking?.agentName ? { agentName: asking.agentName } : {}),
            ...(asking?.parentToolCallId
              ? { parentToolCallId: asking.parentToolCallId }
              : {}),
          },
        },
      };
      emitAgentEvent(envelope);
    } else if (method === "plugins.execute") {
      // Host dispatches plugin_* and mcp_* tools to us; run them and answer.
      void (async () => {
        const q = params as {
          executionId: string;
          sessionId?: string;
          toolCallId?: string;
          toolName: string;
          args: unknown;
          mode?: string;
        };
        const projectPath = q.sessionId
          ? (sessionProjects.get(q.sessionId) ?? null)
          : null;
        const tool = plugins.getTools().find((t) => t.fullName === q.toolName);
        let payload: Record<string, unknown>;
        if (q.toolName.startsWith("mcp_")) {
          try {
            const result = await userMcp.callTool(q.toolName, q.args, projectPath);
            payload = { executionId: q.executionId, ok: true, content: result ?? null };
          } catch (e) {
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode:
                (e as { errorCode?: string })?.errorCode ?? "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        } else if (!tool) {
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: { error: `plugin tool not loaded: ${q.toolName}` },
          };
        } else if (!pluginActiveInProject(tool.pluginId, projectPath)) {
          // The catalog already hid it, but a session assembled before the
          // scope changed can still ask.
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: {
              error: `plugin tool ${q.toolName} is not enabled for this project`,
            },
          };
        } else {
          try {
            let modelKey: string | undefined;
            let thinkingLevel: string | undefined;
            // Host-core sends the session mode; fall back to a session.get
            // call when it is missing (legacy callers). The plugin-runtime
            // uses the mode to enforce plan-safe action restrictions
            // (ADR 0211).
            let sessionMode: "agent" | "plan" | "goal" | undefined;
            const normalizedMode = typeof q.mode === "string" ? q.mode : undefined;
            if (normalizedMode === "agent" || normalizedMode === "plan" || normalizedMode === "goal") {
              sessionMode = normalizedMode;
            } else if (q.sessionId && runtimeState.host) {
              try {
                const detail = await runtimeState.host.call<{
                  session?: {
                    mode?: string;
                    providerId?: string;
                    modelId?: string;
                    thinkingLevel?: string;
                  };
                }>("session.get", { id: q.sessionId });
                const session = detail?.session;
                if (session?.mode === "agent" || session?.mode === "plan" || session?.mode === "goal") {
                  sessionMode = session.mode;
                }
                if (session?.providerId && session?.modelId) {
                  modelKey = `${session.providerId}/${session.modelId}`;
                }
                thinkingLevel = session?.thinkingLevel;
              } catch {
                // Executor identity is best-effort; the tool can still run.
              }
            }
            const result = await tool.execute(q.args, {
              sessionId: q.sessionId,
              mode: sessionMode,
              modelKey,
              thinkingLevel,
            });
            payload = {
              executionId: q.executionId,
              ok: true,
              content: result ?? null,
            };
          } catch (e) {
            const code =
              e && typeof e === "object" && "code" in e && typeof e.code === "string"
                ? e.code
                : "TOOL_FAILED";
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode: code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        }
        logger.app("plugin", "info", "plugin tool executed", {
          toolCallId: q.toolCallId,
          pluginId: tool?.pluginId,
          data: { toolName: q.toolName, ok: payload.ok === true },
        });
        try {
          await h.call("plugins.resolveExecution", payload);
        } catch (e) {
          logger.app("plugin", "warn", "plugin execution resolve failed", {
            data: String(e),
          });
        }
        for (const toast of plugins.drainToasts()) {
          sendToRenderer(IPC.event.toast, { message: toast });
        }
      })();
    } else if (
      method === "keyboard.shortcut" &&
      process.platform === "win32" &&
      (params as { binding?: unknown })?.binding === "Alt+Space"
    ) {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "Windows global shortcut failed", {
          data: String(error),
        }),
      );
    } else if (method === "plans.changed") {
      sendToRenderer(IPC.event.plansChanged, params);
    }
  });
  h.onExit(({ code, signal, intentional }) => {
    if (runtimeState.host !== h) return;
    logger.flushChild("host");
    runtimeState.host = null;
    if (intentional || isQuitting()) return;
    for (const [executionId, sessionId] of claimedExecutionSessions) {
      if (approvedExecutionIdsBySession.get(sessionId) === executionId) {
        void finishTurn(sessionId, "aborted", "PLAN_EXECUTION_INTERRUPTED");
      }
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    logger.app("runtime", "error", "host-core exited unexpectedly", {
      code: ErrorCodes.HOST_UNAVAILABLE,
      data: { exitCode: code, signal },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "host",
      restarting: true,
    });
    void superviseRestart("host");
  });
  };
  const startHost = async (): Promise<void> => {

  assertLinuxGlibcSupported();
  const h = new HostProcess(dataDir, (text) => logger.child("host", text));
  wireHost(h);
  runtimeState.host = h;
  try {
    await h.handshake();
    logger.app("runtime", "info", "host-core handshake ok", {
      data: { generation: h.generation },
    });
    void importLegacyScheduled();
    // Drain before the renderer can session.get. Assistant/tool rows live in
    // this outbox until host-core appends them; a cold start that raced the
    // flush showed only user prompts (issue #42 / D327). Boot leaves
    // completed checkpoints in place so this drain can land the finished
    // row first; leftovers are then promoted as complete.
    await persistenceOutbox.flush(() => runtimeState.host);
    try {
      await h.call("session.recoverInflightMessages");
    } catch (error) {
      logger.app("persistence", "warn", "in-flight reply recovery after outbox drain failed", {
        data: String(error),
      });
    }
  } catch (error) {
    if (runtimeState.host === h) runtimeState.host = null;
    logger.flushChild("host");
    await h.dispose();
    throw error;
  }
  };
  return { wireHost, startHost };
}

