/**
 * Node pi agent sidecar.
 * Protocol: NDJSON JSON-RPC on stdio with Electron main.
 * Host access is proxied through main (single host-core process).
 */
import { randomUUID } from "node:crypto";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { ParentHostProxy } from "./parent-host-proxy.js";
import { visionFromModelConfig } from "./model-capabilities.js";
import { hydrateAttachmentHistory } from "./attachment-history.js";
import { classifyAgentError } from "./agent-errors.js";
import { readLocalRequestErrorDetails } from "./local-request-errors.js";
import {
  DesktopAgentRuntime,
  type PluginToolDef,
  type RuntimePrompt,
  type RuntimePromptAttachment,
  type RuntimeProviderConfig,
} from "./runtime.js";
import type { PluginSkillDef } from "./plugin-skills-prompt.js";
import type { SessionMessageOrigin, TrustedExtensionSpec } from "@pi-desktop/shared";
import type { ProjectInstructions } from "./project-instructions.js";
import type { CustomSystemPrompt } from "./custom-system-prompt.js";
import {
  normalizeSupportedThinkingLevels,
  normalizeThinkingLevel,
} from "./sidecar-config.js";
import { applyNodeNetworkProxy } from "./node-proxy.js";
import { NATIVE_PI_SESSION_PREFIX, nativePiService } from "./native-pi-session.js";
import {
  isCommandShellOption,
  normalizeMode,
  normalizeNetworkProxy,
  OAUTH_AUTH_KIND,
  readNdjsonLines,
} from "@pi-desktop/shared";
import type {
  AgentEventEnvelope,
  AskToolResolution,
  SubagentDefinition,
  ContextCompactionRecord,
  ContextCompactionSettings,
  CommandShellOption,
  Mode,
  PlanExecution,
  SessionThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import { AcpSessionRuntime, type AcpAgentConfig } from "@pi-desktop/acp-client";

type RuntimeMap = Map<string, DesktopAgentRuntime>;

/**
 * Sessions whose turns are executed by an external ACP agent.
 *
 * Kept apart from the pi map on purpose. The pi runtime is the app's main path
 * and its methods (`matches`, `steer`, `compactManually`, `resolveAskTool`) are
 * pi-specific; a separate map means no existing call site changes behaviour,
 * and every ACP entry point is an explicit branch you can grep for.
 */
type AcpRuntimeMap = Map<string, AcpSessionRuntime>;

const runtimes: RuntimeMap = new Map();
const acpRuntimes: AcpRuntimeMap = new Map();

/** Whichever backend owns this session, if any. */
function runtimeForSession(
  sessionId: string,
): DesktopAgentRuntime | AcpSessionRuntime | undefined {
  return acpRuntimes.get(sessionId) ?? runtimes.get(sessionId);
}

/**
 * Narrow to the pi runtime for pi-only features, with an error the UI can show
 * instead of a crash: an external agent has no manual compaction, steering or
 * asktool, and pretending otherwise would be a lie in the transcript.
 */
function requirePiRuntime(
  runtime: DesktopAgentRuntime | AcpSessionRuntime | undefined,
  feature: string,
): DesktopAgentRuntime {
  if (!runtime) {
    throw Object.assign(new Error("runtime not found for session"), {
      rpcCode: -32000,
      errorCode: "RUNTIME_NOT_FOUND",
    });
  }
  if (!isPiRuntime(runtime)) {
    throw Object.assign(
      new Error(`this session is driven by an external agent; ${feature} is not available`),
      { rpcCode: -32000, errorCode: "UNSUPPORTED_FOR_BACKEND" },
    );
  }
  return runtime;
}

function isPiRuntime(
  runtime: DesktopAgentRuntime | AcpSessionRuntime,
): runtime is DesktopAgentRuntime {
  return runtime instanceof DesktopAgentRuntime;
}
const hostProxy = new ParentHostProxy();
const testRuntimeIds = new WeakMap<DesktopAgentRuntime, string>();
function testRuntimeIdentity(sessionId: string) {
  if (process.env.PI_DESKTOP_PLAN_UI_PROBE !== "1") {
    throw Object.assign(new Error("test runtime identity RPC is unavailable"), {
      rpcCode: -32601,
    });
  }
  const runtime = runtimes.get(sessionId);
  if (!runtime) {
    throw Object.assign(new Error("runtime not found for session"), {
      rpcCode: -32000,
      errorCode: "RUNTIME_NOT_FOUND",
    });
  }
  let runtimeId = testRuntimeIds.get(runtime);
  if (!runtimeId) {
    runtimeId = randomUUID();
    testRuntimeIds.set(runtime, runtimeId);
  }
  const status = runtime.getStatus();
  return {
    runtimeId,
    sessionId: runtime.sessionId,
    mode: runtime.getMode(),
    modelId: status.modelId,
    status: {
      isRunning: status.isRunning,
      currentTurnId: status.currentTurnId,
      planningState: status.planningState,
      pendingToolConfirmations: status.pendingToolConfirmations,
      ...(status.pendingPlanId ? { pendingPlanId: status.pendingPlanId } : {}),
    },
  };
}

type RuntimeParams = {
  sessionId: string;
  mode?: Mode;
  /** Durable host turn ID for the prompt currently being executed. */
  turnId?: string;
  thinkingLevel?: SessionThinkingLevel;
  infiniteProviderRetry?: boolean;
  provider: RuntimeProviderConfig;
  commandShell: CommandShellOption;
  pluginTools?: PluginToolDef[];
  pluginSkills?: PluginSkillDef[];
  /** Trusted extensions enabled for this session (D387). */
  trustedExtensions?: TrustedExtensionSpec[];
  /** Delegates this session may spawn through `Task` (ADR 0062). */
  subagents?: SubagentDefinition[];
  /** Provider bindings for pinned models, keyed by `subagentModelKey`. */
  subagentProviders?: Record<string, RuntimeProviderConfig>;
  /** Opted-in override keys, separate from definition-only pinned bindings. */
  subagentModelKeys?: string[];
  scratchDir?: string;
  /** Session-bound workspace root supplied by Electron main. */
  projectPath?: string;
  customSystemPrompt?: CustomSystemPrompt;
  projectInstructions?: ProjectInstructions;
  projectMemory?: string;
  compactionSettings?: ContextCompactionSettings;
  attachmentsDir?: string;
  userMessageId?: string;
  sessionMessage?: SessionMessageOrigin;
  attachments?: RuntimePromptAttachment[];
  /**
   * When present the session is executed by an external ACP agent instead of
   * the built-in pi agent. `provider` is then unused: the agent brings its own
   * models and credentials, and the host does not try to describe them.
   */
  acp?: AcpAgentConfig;
};

function write(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * Create or reuse the ACP session runtime for a host session.
 *
 * The agent is responsible for its own models, so there is nothing to validate
 * here beyond the command itself — the ACP client already refuses an empty or
 * unlaunchable command. Model selection happens inside the agent: it advertises
 * its picker in `session/new` and we set the configured one with
 * `session/set_config_option`.
 */
async function acpRuntimeFor(params: RuntimeParams): Promise<AcpSessionRuntime> {
  const sessionId = String(params.sessionId);
  const config = params.acp as AcpAgentConfig;
  const existing = acpRuntimes.get(sessionId);
  if (existing && sameAcpConfig(existing, config)) {
    if (existing.getStatus().isRunning) {
      throw Object.assign(new Error("session already has an active turn"), {
        rpcCode: -32000,
        errorCode: "AGENT_BUSY",
      });
    }
    return existing;
  }
  if (existing) {
    await existing.dispose();
    acpRuntimes.delete(sessionId);
  }
  const runtime = new AcpSessionRuntime({
    ...config,
    sessionId,
    hooks: {
      emit: (envelope) => notify("agent.event", envelope),
      // Not wired yet: permissions and filesystem callbacks need a host route
      // that does not exist (the sidecar's reverse-request path only knows
      // `host.proxy`). Failing closed is the safe default — an agent that wants
      // to run a tool gets a refusal instead of an unattended grant.
      requestPermission: async () => undefined,
    },
    onStderr: (chunk) => write({ level: "warn", source: "acp", message: chunk.trim() }),
  });
  acpRuntimes.set(sessionId, runtime);
  return runtime;
}

function sameAcpConfig(runtime: AcpSessionRuntime, config: AcpAgentConfig): boolean {
  const info = runtime.config();
  return (
    info.command === config.command &&
    info.cwd === config.cwd &&
    info.modelId === (config.modelId ?? undefined) &&
    // Args are part of the identity: `opencode` and `opencode acp` are the same
    // command and behave completely differently. Reusing the first for the
    // second would leave the session talking to the wrong mode.
    info.args.length === config.args.length &&
    info.args.every((arg, i) => arg === config.args[i])
  );
}

/**
 * Attach the vendor-account auth resolver to a provider binding.
 *
 * The launch payload for an OAuth row carries no credential at all — main
 * strips it — so the sidecar hands pi-ai a callback that asks main for request
 * auth instead. Main answers only for a provider it bound to this session, and
 * only with a short-lived `ModelAuth`; the refresh token stays on its side.
 */
function withVendorAuth<T extends RuntimeProviderConfig>(
  sessionId: string,
  provider: T,
): T {
  if (provider?.authKind !== OAUTH_AUTH_KIND) return provider;
  return {
    ...provider,
    resolveAuth: () =>
      hostProxy.call<ModelAuth>("provider.resolveAuth", {
        sessionId,
        providerId: provider.id,
      }),
  };
}

function notify(method: string, params: unknown) {
  write({ jsonrpc: "2.0", method, params });
}

function respond(id: string | number, result?: unknown, error?: unknown) {
  if (error) write({ jsonrpc: "2.0", id, error });
  else write({ jsonrpc: "2.0", id, result });
}

async function runtimeFor(
  params: RuntimeParams,
  currentPrompt?: string,
): Promise<DesktopAgentRuntime | AcpSessionRuntime> {
  const sessionId = String(params.sessionId);
  if (params.acp) return acpRuntimeFor(params);
  const mode = normalizeMode(params.mode);
  if (!isCommandShellOption(params.commandShell) || !params.commandShell.available) {
    throw Object.assign(new Error("active command shell is invalid or unavailable"), {
      rpcCode: -32000,
      errorCode: "COMMAND_SHELL_INVALID",
    });
  }
  const providerInput = params.provider;
  const provider = withVendorAuth(sessionId, {
    ...providerInput,
    supportsReasoning: providerInput?.supportsReasoning === true,
    supportedThinkingLevels: normalizeSupportedThinkingLevels(
      providerInput?.supportedThinkingLevels,
      providerInput?.supportsReasoning === true,
    ),
  });
  const thinkingLevel = normalizeThinkingLevel(params.thinkingLevel);
  const pluginTools = params.pluginTools ?? [];
  const pluginSkills = params.pluginSkills ?? [];
  const trustedExtensions = params.trustedExtensions ?? [];
  const subagents = params.subagents ?? [];
  const subagentModelKeys = params.subagentModelKeys ?? [];
  const subagentProviders = Object.fromEntries(
    Object.entries(params.subagentProviders ?? {}).map(([key, pinned]) => [
      key,
      withVendorAuth(sessionId, pinned),
    ]),
  );
  if (
    !provider?.modelId ||
    (!provider.apiKey &&
      provider.authKind !== "none" &&
      provider.authKind !== OAUTH_AUTH_KIND)
  ) {
    throw Object.assign(new Error("model/provider not configured"), {
      rpcCode: -32000,
      errorCode: "MODEL_NOT_CONFIGURED",
    });
  }

  const existing = runtimes.get(sessionId);
  if (existing?.getStatus().isRunning) {
    throw Object.assign(new Error("session already has an active turn"), {
      rpcCode: -32000,
      errorCode: "AGENT_BUSY",
    });
  }
  const reusable = existing?.matches({
    mode,
    provider,
    thinkingLevel,
    pluginTools,
    pluginSkills,
    trustedExtensions,
    subagents,
    subagentProviders,
    subagentModelKeys,
    projectInstructions: params.projectInstructions,
    customSystemPrompt: params.customSystemPrompt,
    projectMemory: params.projectMemory,
    projectPath: params.projectPath,
    commandShell: params.commandShell,
  })
    ? existing
    : undefined;
  if (existing && !reusable) {
    await existing.dispose();
    runtimes.delete(sessionId);
  }
  if (reusable) {
    reusable.setCompactionSettings(params.compactionSettings);
    reusable.setInfiniteProviderRetry(params.infiniteProviderRetry === true);
    reusable.setMode(mode);
    return reusable;
  }

  let history: UiMessage[] = [];
  let compaction: ContextCompactionRecord | undefined;
  try {
    const detail = await hostProxy.call<{
      session?: {
        messages?: UiMessage[];
        compaction?: ContextCompactionRecord;
      } | null;
    }>("session.get", { id: sessionId });
    const supportsVision = visionFromModelConfig(params.provider.modelConfig);
    history = await hydrateAttachmentHistory(detail?.session?.messages ?? [], {
      scratchDir: params.scratchDir,
      projectPath: params.projectPath,
      attachmentsDir: params.attachmentsDir,
      supportsVision,
    });
    compaction = detail?.session?.compaction;
  } catch {
    // History restore is best-effort; a prompt can still start cleanly.
  }
  if (currentPrompt !== undefined) {
    const last = history.at(-1);
    if (
      last?.role === "user" &&
      ((params.userMessageId && last.id === params.userMessageId) ||
        (!params.userMessageId && last.content === currentPrompt))
    ) {
      history = history.slice(0, -1);
    }
  }
  const runtime = new DesktopAgentRuntime({
    host: hostProxy,
    sessionId,
    mode,
    turnId: params.turnId,
    provider,
    commandShell: params.commandShell,
    thinkingLevel,
    infiniteProviderRetry: params.infiniteProviderRetry === true,
    history,
    compaction,
    compactionSettings: params.compactionSettings,
    pluginTools,
    pluginSkills,
    trustedExtensions,
    subagents,
    subagentProviders,
    subagentModelKeys,
    projectPath: params.projectPath,
    customSystemPrompt: params.customSystemPrompt,
    projectInstructions: params.projectInstructions,
    projectMemory: params.projectMemory,
    scratchDir:
      typeof params.scratchDir === "string" && params.scratchDir
        ? params.scratchDir
        : undefined,
    onEvent: (envelope: AgentEventEnvelope) => notify("agent.event", envelope),
  });
  runtimes.set(sessionId, runtime);
  // Load failures are diagnostics, never a failed prompt (spec 16 §4.4).
  await runtime.loadTrustedExtensions().catch(() => undefined);
  if (provider.extensionAgentKey) {
    const activated = await runtime.activateTrustedExtensionAgent(
      provider.extensionAgentKey,
      provider.modelId,
    );
    if (!activated) {
      throw Object.assign(new Error("plugin agent is not available"), {
        rpcCode: -32000,
        errorCode: "MODEL_NOT_CONFIGURED",
      });
    }
  }
  return runtime;
}

function classifiedRuntimeError(err: unknown) {
  const candidate = err as {
    code?: unknown;
    message?: unknown;
    retriable?: unknown;
    details?: unknown;
    errorCode?: unknown;
  };
  if (
    typeof candidate?.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retriable === "boolean"
  ) {
    return {
      code: candidate.code,
      message: candidate.message,
      retriable: candidate.retriable,
      ...(candidate.details !== undefined ? { details: candidate.details } : {}),
    };
  }
  const errorCode = candidate?.errorCode;
  if (typeof errorCode === "string") {
    return {
      code: errorCode,
      message: err instanceof Error ? err.message : String(err),
      retriable: false,
    };
  }
  return classifyAgentError(err);
}

// Host notifications (permissions.request never reaches us — main forwards
// it to the renderer directly; re-emitting it here would duplicate the
// permission dialog delivery).

async function handle(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "sidecar.configure": {
      // Main owns host-core; sidecar only keeps config metadata.
      if (params && typeof params === "object" && "networkProxy" in params) {
        applyNodeNetworkProxy(normalizeNetworkProxy(params.networkProxy));
      }
      return { ok: true, mode: "host-proxy" };
    }
    case "sidecar.health":
      return { ok: true, runtimes: runtimes.size };
    case "native.session.list":
      return { sessions: await nativePiService().list() };
    case "native.session.search":
      return nativePiService().search(String(params.query ?? ""));
    case "native.session.get":
      return {
        session: nativePiService().detail(String(params.id ?? ""), {
          messageBefore: params.messageBefore,
          messageLimit: params.messageLimit,
          messageAround: params.messageAround,
          contentLimit: params.contentLimit,
        }),
      };
    case "native.session.fork":
      return {
        session: nativePiService().fork({
          id: String(params.id ?? ""),
          title: typeof params.title === "string" ? params.title : undefined,
          throughMessageId:
            typeof params.throughMessageId === "string" ? params.throughMessageId : undefined,
        }),
      };
    case "agent.testRuntimeIdentity": {
      return testRuntimeIdentity(String(params.sessionId ?? ""));
    }
    case "agent.prompt": {
      const sessionId = String(params.sessionId);
      const content = String(params.content ?? "");
      if (sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
        return nativePiService().prompt(sessionId, content, (envelope) =>
          notify("native.agent.event", envelope),
          typeof params.userMessageId === "string" ? params.userMessageId : undefined,
        );
      }
      const turnId =
        typeof params.turnId === "string" && params.turnId.trim()
          ? params.turnId
          : randomUUID();
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as RuntimePromptAttachment[])
        : undefined;
      const runtime = await runtimeFor(params, content);
      if (!isPiRuntime(runtime)) {
        // An external agent takes the text turn as-is: it owns prompt assembly,
        // tools and the model, so host-side attachments and thinking levels do
        // not apply to it.
        void runtime
          .prompt(content, turnId)
          .catch((err) => {
            notify("agent.event", {
              sessionId,
              turnId,
              ts: Date.now(),
              event: { type: "error", error: classifiedRuntimeError(err) },
            });
          });
        return { accepted: true, turnId };
      }
      const userMessageId =
        typeof params.userMessageId === "string" && params.userMessageId
          ? params.userMessageId
          : undefined;
      // A `permissionMode` override on `agent.prompt` is the per-turn ceiling
      // from spec §7.3 (R1 leftover). The sidecar accepts it so callers do not
      // have to guard the field, but tool-approval enforcement still consults
      // the session's stored mode inside host-core. Once host-core
      // `session.beginTurn` accepts a per-turn override, this record will drive
      // the enforcement gate; until then it stays a documented stub.
      if (typeof params.permissionMode === "string" && params.permissionMode) {
        // Log-only stub: observable in the sidecar log without affecting
        // execution. Deliberately omitted from user-visible events.
        void params.permissionMode;
      }
      const prompt: RuntimePrompt = {
        text: content,
        attachments,
        ...(params.sessionMessage ? { sessionMessage: params.sessionMessage as SessionMessageOrigin } : {}),
      };
      void runtime.prompt(prompt, userMessageId, turnId).catch((err) => {
        // Rejected-prompt path (pre-flight/transport failures). Streamed
        // provider errors surface via stopReason "error" and are classified
        // and emitted by the runtime itself.
        notify("agent.event", {
          sessionId,
          turnId,
          ts: Date.now(),
          event: {
            type: "error",
            error: classifiedRuntimeError(err),
          },
        });
      });
      return { accepted: true, turnId };
    }
    case "agent.steeringContext":
    case "agent.steer": {
      const runtime = requirePiRuntime(runtimes.get(String(params.sessionId ?? "")), "steering");
      if (!runtime) {
        throw Object.assign(new Error("No active turn to steer"), { errorCode: "TURN_NOT_FOUND" });
      }
      const expectedTurnId = String(params.expectedTurnId ?? "");
      if (method === "agent.steeringContext") return runtime.steeringContext(expectedTurnId);
      return runtime.steer(
        { text: String(params.content ?? ""), attachments: params.attachments },
        expectedTurnId,
        params.message,
      );
    }
    case "agent.executeApprovedPlan": {
      const sessionId = String(params.sessionId ?? "");
      const turnId = String(params.turnId ?? "").trim();
      const execution = params.execution as PlanExecution | undefined;
      if (!sessionId || !turnId || !execution) {
        throw Object.assign(new Error("approved plan execution parameters required"), {
          errorCode: "PLAN_EXECUTION_NOT_FOUND",
        });
      }
      const resolved = await runtimeFor({
        ...params,
        sessionId,
        mode: "agent",
        turnId,
      });
      const runtime = requirePiRuntime(resolved, "approved plan execution");
      void runtime.executeApprovedPlan(execution, turnId).catch((err) => {
        notify("agent.event", {
          sessionId,
          turnId,
          ts: Date.now(),
          event: {
            type: "error",
            error: classifiedRuntimeError(err),
          },
        });
      });
      return { accepted: true, turnId };
    }
    case "agent.compact": {
      const resolved = await runtimeFor(params);
      await requirePiRuntime(resolved, "manual compaction").compactManually();
      return { accepted: true };
    }
    case "agent.abort": {
      const sessionId = String(params.sessionId);
      if (sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
        return nativePiService().abort(sessionId);
      }
      const runtime = runtimeForSession(sessionId);
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (turnId && runtime?.getStatus().currentTurnId !== turnId) return { ok: false, aborted: false };
      await hostProxy.call("plans.abort", { sessionId, ...(turnId ? { turnId } : {}) }).catch(() => undefined);
      if (runtime && runtimeForSession(sessionId) === runtime && (!turnId || runtime.getStatus().currentTurnId === turnId)) {
        await runtime.abort();
      }
      return { ok: true };
    }
    case "agent.stop": {
      const sessionId = String(params.sessionId);
      if (sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
        return nativePiService().abort(sessionId);
      }
      const runtime = runtimeForSession(sessionId);
      return runtime?.requestGracefulStop() ?? { requested: false };
    }
    case "asktool.resolve": {
      const sessionId = String(params.sessionId ?? "");
      const runtime = runtimes.get(sessionId);
      if (!runtime) {
        throw Object.assign(new Error("runtime not found for asktool request"), {
          errorCode: "ASKTOOL_NOT_FOUND",
        });
      }
      return runtime.resolveAskTool(params as AskToolResolution);
    }
    case "extensions.command.run": {
      const sessionId = String(params.sessionId ?? "");
      const runtime = runtimes.get(sessionId);
      if (!runtime) {
        throw Object.assign(new Error("runtime not found for session"), {
          rpcCode: -32000,
          errorCode: "RUNTIME_NOT_FOUND",
        });
      }
      return runtime.runTrustedExtensionCommand(
        String(params.name ?? ""),
        String(params.args ?? ""),
      );
    }
    case "agent.getStatus": {
      const sessionId = String(params.sessionId);
      if (sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
        return nativePiService().status(sessionId);
      }
      const runtime = runtimeForSession(sessionId);
      return {
        status: runtime?.getStatus() ?? {
          sessionId,
          isRunning: false,
          pendingToolConfirmations: 0,
        },
      };
    }
    case "agent.disposeSession": {
      const sessionId = String(params.sessionId);
      if (sessionId.startsWith(NATIVE_PI_SESSION_PREFIX)) {
        nativePiService().dispose(sessionId);
        return { ok: true };
      }
      const runtime = runtimeForSession(sessionId);
      if (runtime) {
        await runtime.dispose();
        if (isPiRuntime(runtime)) runtimes.delete(sessionId);
        else acpRuntimes.delete(sessionId);
      }
      return { ok: true };
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), {
        rpcCode: -32601,
      });
  }
}

readNdjsonLines(process.stdin, async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(
      `[agent-sidecar] Invalid NDJSON frame (${Buffer.byteLength(line, "utf8")} bytes)\n`,
    );
    return;
  }
  // Responses to host.proxy requests from parent
  if (hostProxy.handleParentMessage(msg)) return;

  if (!msg.method || msg.id === undefined) return;
  try {
    const result = await handle(msg.method, msg.params ?? {});
    respond(msg.id, result);
  } catch (err: any) {
    // Restore validation can fail before a runtime/stream exists. Preserve its
    // safe provenance in the existing RPC error data instead of flattening it.
    const local = readLocalRequestErrorDetails(err) ? classifyAgentError(err) : undefined;
    respond(msg.id, undefined, {
      code: err.rpcCode ?? -32000,
      message: local?.message ?? (err instanceof Error ? err.message : String(err)),
      data: local
        ? { errorCode: local.code, retriable: local.retriable, details: local.details }
        : { errorCode: err.errorCode ?? "INTERNAL" },
    });
  }
});

// A rejected promise nobody awaits (a stray async event handler, a background
// host call) must not take every session's runtime down with it: Node's
// default for `unhandledRejection` is to exit the process. Log and carry on;
// the affected session surfaces its own error through the normal event path.
process.on("exit", () => nativePiService().disposeAll());

process.on("unhandledRejection", (reason) => {
  const detail =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}${reason.stack ? `\n${reason.stack}` : ""}`
      : String(reason);
  process.stderr.write(`[agent-sidecar] unhandled promise rejection: ${detail}\n`);
});

const bootProxy = process.env.PI_DESKTOP_PROXY_JSON;
if (bootProxy) {
  try {
    applyNodeNetworkProxy(normalizeNetworkProxy(JSON.parse(bootProxy)));
  } catch {
    // Invalid boot payload is ignored; sidecar.configure will replace it.
  }
}
process.stderr.write("[agent-sidecar] ready (host-proxy mode)\n");
