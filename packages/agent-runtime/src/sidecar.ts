/**
 * Node pi agent sidecar.
 * Protocol: NDJSON JSON-RPC on stdio with Electron main.
 * Host access is proxied through main (single host-core process).
 */
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { ParentHostProxy } from "./parent-host-proxy.js";
import { visionFromModelConfig } from "./model-capabilities.js";
import { classifyAgentError } from "./agent-errors.js";
import {
  DesktopAgentRuntime,
  type PluginToolDef,
  type RuntimePrompt,
  type RuntimePromptAttachment,
  type RuntimeProviderConfig,
} from "./runtime.js";
import type { PluginSkillDef } from "./plugin-skills-prompt.js";
import type { ProjectInstructions } from "./project-instructions.js";
import {
  normalizeSupportedThinkingLevels,
  normalizeThinkingLevel,
} from "./sidecar-config.js";
import {
  formatFileInsert,
  isCommandShellOption,
  normalizeMode,
  OAUTH_AUTH_KIND,
} from "@pi-desktop/shared";
import type {
  AgentEventEnvelope,
  AskToolResolution,
  SubagentDefinition,
  ContextCompactionRecord,
  ContextCompactionSettings,
  CommandShellOption,
  Mode,
  MessageAttachment,
  PlanExecution,
  ThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";

type RuntimeMap = Map<string, DesktopAgentRuntime>;

const runtimes: RuntimeMap = new Map();
const hostProxy = new ParentHostProxy();
const testRuntimeIds = new WeakMap<DesktopAgentRuntime, string>();
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

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
  thinkingLevel?: ThinkingLevel;
  provider: RuntimeProviderConfig;
  commandShell: CommandShellOption;
  pluginTools?: PluginToolDef[];
  pluginSkills?: PluginSkillDef[];
  /** Delegates this session may spawn through `Task` (ADR 0062). */
  subagents?: SubagentDefinition[];
  /** Provider bindings for pinned models, keyed by `subagentModelKey`. */
  subagentProviders?: Record<string, RuntimeProviderConfig>;
  scratchDir?: string;
  /** Session-bound workspace root supplied by Electron main. */
  projectPath?: string;
  projectInstructions?: ProjectInstructions;
  compactionSettings?: ContextCompactionSettings;
  attachmentsDir?: string;
  userMessageId?: string;
  attachments?: RuntimePromptAttachment[];
};

function write(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
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

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function replayedAttachmentPath(
  params: RuntimeParams,
  attachment: NonNullable<UiMessage["attachments"]>[number],
  source: string,
): Promise<string> {
  if (!params.scratchDir || !attachment.ref.startsWith("attachments/")) {
    return source;
  }
  const root = resolve(params.scratchDir, "replayed");
  await mkdir(root, { recursive: true });
  const safeName =
    attachment.name.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "attachment";
  const suffix = createHash("sha256")
    .update(attachment.ref)
    .digest("hex")
    .slice(0, 12);
  const target = resolve(root, `${safeName}-${suffix}`);
  try {
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return target;
}

async function hydrateAttachmentHistory(
  history: UiMessage[],
  params: RuntimeParams,
): Promise<UiMessage[]> {
  // Same helper the live prompt path uses, on the same override-shaped config,
  // so a replayed image is inlined exactly when a fresh one would be.
  const supportsVision = visionFromModelConfig(params.provider.modelConfig);
  const roots = [
    params.scratchDir,
    params.projectPath,
    params.attachmentsDir,
  ].filter((value): value is string => Boolean(value));
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return undefined;
      }
    }),
  );
  const resolveAttachment = async (
    attachment: NonNullable<UiMessage["attachments"]>[number],
  ): Promise<{ attachment: MessageAttachment; fallbackPath?: string }> => {
    const ref = attachment.ref.trim();
    if (!ref) return { attachment };
    const candidate =
      ref.startsWith("attachments/") && params.attachmentsDir
        ? resolve(params.attachmentsDir, ref.slice("attachments/".length))
        : isAbsolute(ref)
          ? resolve(ref)
          : params.projectPath
            ? resolve(params.projectPath, ref)
            : undefined;
    if (!candidate) return { attachment };
    try {
      const canonical = await realpath(candidate);
      if (!canonicalRoots.some((root) => root && pathInside(root, canonical))) {
        return { attachment };
      }
      const shouldInline = attachment.kind === "image" && supportsVision;
      const size = (await stat(canonical)).size;
      const bytes =
        shouldInline && size <= MAX_INLINE_IMAGE_BYTES
          ? await readFile(canonical)
          : undefined;
      if (attachment.kind === "image" && supportsVision && bytes) {
        return { attachment: { ...attachment, data: bytes.toString("base64") } };
      }
      return {
        attachment,
        fallbackPath: await replayedAttachmentPath(
          params,
          attachment,
          canonical,
        ),
      };
    } catch {
      return { attachment };
    }
  };

  return Promise.all(
    history.map(async (message) => {
      if (message.role !== "user" || !message.attachments?.length) return message;
      const resolved = await Promise.all(message.attachments.map(resolveAttachment));
      const fallbackPaths = resolved
        .map((item) => item.fallbackPath)
        .filter((path): path is string => Boolean(path))
        .map((path) => formatFileInsert(path, "file"))
        .join("")
        .trim();
      const content = message.content.trim()
        ? fallbackPaths
          ? `${message.content}\n${fallbackPaths}`
          : message.content
        : fallbackPaths;
      return {
        ...message,
        content,
        attachments: resolved.map((item) => item.attachment),
      };
    }),
  );
}

async function runtimeFor(
  params: RuntimeParams,
  currentPrompt?: string,
): Promise<DesktopAgentRuntime> {
  const sessionId = String(params.sessionId);
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
  const subagents = params.subagents ?? [];
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
    subagents,
    subagentProviders,
    projectInstructions: params.projectInstructions,
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
    reusable.setMode(mode);
    await reusable.ensureParentA2A();
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
    history = await hydrateAttachmentHistory(detail?.session?.messages ?? [], params);
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
    host: hostProxy as any,
    sessionId,
    mode,
    turnId: params.turnId,
    provider,
    commandShell: params.commandShell,
    thinkingLevel,
    history,
    compaction,
    compactionSettings: params.compactionSettings,
    pluginTools,
    pluginSkills,
    subagents,
    subagentProviders,
    projectPath: params.projectPath,
    projectInstructions: params.projectInstructions,
    scratchDir:
      typeof params.scratchDir === "string" && params.scratchDir
        ? params.scratchDir
        : undefined,
    onEvent: (envelope: AgentEventEnvelope) => notify("agent.event", envelope),
  });
  runtimes.set(sessionId, runtime);
  await runtime.ensureParentA2A();
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
      return { ok: true, mode: "host-proxy" };
    }
    case "sidecar.health":
      return { ok: true, runtimes: runtimes.size };
    case "agent.testRuntimeIdentity": {
      return testRuntimeIdentity(String(params.sessionId ?? ""));
    }
    case "agent.prompt": {
      const sessionId = String(params.sessionId);
      const content = String(params.content ?? "");
      const turnId =
        typeof params.turnId === "string" && params.turnId.trim()
          ? params.turnId
          : randomUUID();
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as RuntimePromptAttachment[])
        : undefined;
      const runtime = await runtimeFor(params, content);
      const userMessageId =
        typeof params.userMessageId === "string" && params.userMessageId
          ? params.userMessageId
          : undefined;
      const prompt: RuntimePrompt = { text: content, attachments };
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
    case "agent.executeApprovedPlan": {
      const sessionId = String(params.sessionId ?? "");
      const turnId = String(params.turnId ?? "").trim();
      const execution = params.execution as PlanExecution | undefined;
      if (!sessionId || !turnId || !execution) {
        throw Object.assign(new Error("approved plan execution parameters required"), {
          errorCode: "PLAN_EXECUTION_NOT_FOUND",
        });
      }
      const runtime = await runtimeFor({
        ...params,
        sessionId,
        mode: "agent",
        turnId,
      });
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
      const runtime = await runtimeFor(params);
      await runtime.compactManually();
      return { accepted: true };
    }
    case "agent.abort": {
      const sessionId = String(params.sessionId);
      await hostProxy.call("plans.abort", { sessionId }).catch(() => undefined);
      const runtime = runtimes.get(sessionId);
      if (runtime) await runtime.abort();
      return { ok: true };
    }
    case "agent.stop": {
      const sessionId = String(params.sessionId);
      const runtime = runtimes.get(sessionId);
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
    case "agent.getStatus": {
      const sessionId = String(params.sessionId);
      const runtime = runtimes.get(sessionId);
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
      const runtime = runtimes.get(sessionId);
      if (runtime) {
        await runtime.dispose();
        runtimes.delete(sessionId);
      }
      return { ok: true };
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), {
        rpcCode: -32601,
      });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Responses to host.proxy requests from parent
  if (hostProxy.handleParentMessage(msg)) return;

  if (!msg.method || msg.id === undefined) return;
  try {
    const result = await handle(msg.method, msg.params ?? {});
    respond(msg.id, result);
  } catch (err: any) {
    respond(msg.id, undefined, {
      code: err.rpcCode ?? -32000,
      message: err instanceof Error ? err.message : String(err),
      data: { errorCode: err.errorCode ?? "INTERNAL" },
    });
  }
});

process.stderr.write("[agent-sidecar] ready (host-proxy mode)\n");
