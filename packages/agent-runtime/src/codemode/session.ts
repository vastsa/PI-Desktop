/**
 * Binds the codemode tool to one session runtime. The runtime supplies only
 * narrow closures; the sandbox reaches nothing else. Nested calls resolve
 * against the session catalog and pass the session's own hooks, so ToolSearch
 * activation, mode policy, extension hooks, Host permission/approval, audit,
 * cancellation and file admission are the same as for a direct call.
 */
import type { AgentTool, ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, MessageUsage } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { CODEMODE_TOOL_NAME } from "./limits.js";
import { NestedToolRunner, type NestedToolHost } from "./nested-calls.js";
import { createRuntimeModelHost } from "./runtime-models.js";
import { createCodemodeTool } from "./tool.js";

export type SessionCodemodeBindings = {
  sessionId: string;
  /** Every tool of the session catalog; nested calls resolve against it. */
  catalog(): readonly AgentTool[];
  /** Tools callable right now: core plus ToolSearch-activated, allowed in this mode. */
  active(): readonly AgentTool[];
  /** Control and interactive tools a script must never call. */
  excluded: ReadonlySet<string>;
  hooks: ToolCallHooks;
  model(): Model<Api>;
  turnId(): string | undefined;
  emit(envelope: AgentEventEnvelope): void;
  emitUsage(usage: MessageUsage, turnId: string | undefined): void;
  activeToolCalls: Map<string, { toolName: string; args: unknown; startedAt: number }>;
  settleBatch(message: AssistantMessage): void;
  provider(): RuntimeProviderConfig;
  jevApiKey?: string;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createSessionCodemodeTool(bindings: SessionCodemodeBindings): AgentTool {
  const host: NestedToolHost = {
    tools: () => bindings.catalog(),
    hooks: () => bindings.hooks,
    issuingMessage: (toolCall) => {
      const model = bindings.model();
      return {
        role: "assistant",
        content: [toolCall],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
    },
    emit: (event, nestedParentToolCallId, ts = Date.now()) => {
      const turnId = bindings.turnId();
      bindings.emit({
        sessionId: bindings.sessionId,
        ...(turnId ? { turnId } : {}),
        ts,
        event,
        nestedParentToolCallId,
      });
    },
    track: (toolCallId, info) => {
      bindings.activeToolCalls.set(toolCallId, info);
    },
    untrack: (toolCallId) => {
      bindings.activeToolCalls.delete(toolCallId);
    },
    settleBatch: (message) => bindings.settleBatch(message),
  };
  return createCodemodeTool({
    runner: new NestedToolRunner(host),
    callableTools: () =>
      bindings.active().filter((tool) => tool.name !== CODEMODE_TOOL_NAME && !bindings.excluded.has(tool.name)),
    models: createRuntimeModelHost({
      provider: bindings.provider,
      sessionId: bindings.sessionId,
      ...(bindings.jevApiKey ? { jevApiKey: bindings.jevApiKey } : {}),
      turnId: bindings.turnId,
      emitUsage: bindings.emitUsage,
    }),
  });
}
