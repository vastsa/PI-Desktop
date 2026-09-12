/**
 * Electron-main helpers for plugin models.list / session.getLlmContext /
 * agent.complete. Credentials stay in this process.
 */

import type { Context } from "@earendil-works/pi-ai";
import {
  PLUGIN_COMPLETE_DEFAULT_TAIL,
  pluginLlmContextFromTranscript,
  serializePluginLlmContext,
} from "@pi-desktop/agent-runtime";
import type {
  PluginCompleteInput,
  PluginLlmContext,
  PluginModelInfo,
} from "@pi-desktop/plugin-sdk";
import type { ContextCompactionRecord, ThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";

export function parsePluginModelKey(modelKey: string): { providerId: string; modelId: string } | null {
  const slash = modelKey.indexOf("/");
  if (slash <= 0 || slash === modelKey.length - 1) return null;
  return {
    providerId: modelKey.slice(0, slash),
    modelId: modelKey.slice(slash + 1),
  };
}

export function asPluginThinkingLevel(value: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "off";
}

type ListedProvider = {
  id: string;
  name: string;
  enabled?: boolean;
  hasSecret?: boolean;
  hasOauth?: boolean;
  authKind?: string;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: ThinkingLevel[];
  defaultModelId?: string;
  models?: Array<{
    id: string;
    thinkingLevels?: ThinkingLevel[];
  }>;
};

export function listReadyPluginModels(providers: ListedProvider[]): PluginModelInfo[] {
  const models: PluginModelInfo[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const ready =
      provider.hasSecret === true ||
      provider.hasOauth === true ||
      provider.authKind === "none";
    if (!ready) continue;
    const bindings =
      provider.models?.length
        ? provider.models
        : provider.defaultModelId
          ? [{ id: provider.defaultModelId, thinkingLevels: provider.supportedThinkingLevels }]
          : [];
    for (const binding of bindings) {
      const modelId = String(binding.id ?? "").trim();
      if (!modelId) continue;
      const thinkingLevels =
        binding.thinkingLevels?.length
          ? [...binding.thinkingLevels]
          : [...(provider.supportedThinkingLevels ?? ["off"])];
      models.push({
        key: `${provider.id}/${modelId}`,
        providerId: provider.id,
        providerName: provider.name,
        modelId,
        label: `${modelId} (${provider.name})`,
        supportsReasoning:
          thinkingLevels.some((level) => level !== "off") || provider.supportsReasoning === true,
        thinkingLevels,
      });
    }
  }
  return models;
}

export function pluginSessionContextFromSession(
  sessionId: string,
  session: {
    messages?: UiMessage[];
    compaction?: ContextCompactionRecord;
    providerId?: string;
    modelId?: string;
    thinkingLevel?: string;
  } | null | undefined,
  stripToolName?: string,
): PluginLlmContext {
  const projected = pluginLlmContextFromTranscript(session?.messages ?? [], {
    compaction: session?.compaction,
    stripToolName,
  });
  const modelKey =
    session?.providerId && session?.modelId
      ? `${session.providerId}/${session.modelId}`
      : null;
  return {
    sessionId,
    modelKey,
    ...(session?.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    messages: projected.messages,
    truncated: projected.truncated,
  };
}

export function pluginCompleteContext(input: PluginCompleteInput & {
  sessionContext?: PluginLlmContext;
}): Context {
  const parts: Array<{ role: "user"; content: string; timestamp: number }> = [];
  if (input.includeSessionContext && input.sessionContext) {
    const serialized = serializePluginLlmContext(input.sessionContext.messages);
    if (serialized.trim()) {
      parts.push({ role: "user", content: serialized, timestamp: Date.now() });
    }
  }
  for (const message of input.messages ?? []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = String(message.content ?? "").trim();
    if (!content) continue;
    parts.push({
      role: "user",
      content: message.role === "assistant" ? `### Assistant\n${content}` : content,
      timestamp: Date.now(),
    });
  }
  if (parts.length === 0) {
    parts.push({
      role: "user",
      content: PLUGIN_COMPLETE_DEFAULT_TAIL,
      timestamp: Date.now(),
    });
  } else if (input.includeSessionContext && (input.messages?.length ?? 0) === 0) {
    parts.push({
      role: "user",
      content: PLUGIN_COMPLETE_DEFAULT_TAIL,
      timestamp: Date.now(),
    });
  }
  return {
    systemPrompt: input.system?.trim() || undefined,
    messages: parts,
  };
}
