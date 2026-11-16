/** Resolve the provider/model a session should keep after first selection. */
import {
  isImageOnlyChatModel,
  type ImageGenerationBinding,
  type ModelInfo,
} from "@pi-desktop/shared";
import { composerModelMetadata } from "./composer-models.ts";
import type { RecentModel } from "./recent-models";

export type SessionModelRef = {
  providerId?: string;
  modelId?: string;
};

export type SessionModelProvider = {
  id: string;
  defaultModelId?: string;
  models?: Array<{ id: string }>;
  enabled?: boolean;
  hasSecret?: boolean;
  authKind?: string;
};

export type SessionModelSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
  imageGeneration?: SessionModelRef | null;
  imageGenerationModels?: SessionModelRef[] | null;
};

/** Only configured, runnable chat bindings can be inherited by a new chat. */
export function availableRecentModels(
  recentModels: readonly RecentModel[],
  providers: readonly SessionModelProvider[],
  settings?: SessionModelSettings | null,
  discovered?: readonly ModelInfo[],
): RecentModel[] {
  const bindings = [
    ...(settings?.imageGenerationModels ?? []),
    ...(settings?.imageGeneration ? [settings.imageGeneration] : []),
  ].filter((binding): binding is ImageGenerationBinding =>
    !!binding.providerId && !!binding.modelId);
  return recentModels.filter(entry => {
    const provider = providers.find(item => item.id === entry.providerId);
    const ids = provider?.models?.length ? provider.models.map(model => model.id) : [provider?.defaultModelId];
    // Same chat-eligibility answer the picker, canSend and launch use: only a
    // pure image-generation endpoint (or a discovered row publishing no text
    // output) is excluded, so a dual-capability default model can be inherited
    // by a new chat (#2253).
    return provider && provider.enabled !== false &&
      (provider.authKind === undefined || provider.authKind === "none" || provider.hasSecret) &&
      ids.some(id => id?.toLowerCase() === entry.modelId.toLowerCase()) &&
      !isImageOnlyChatModel(
        bindings,
        provider.id,
        entry.modelId,
        composerModelMetadata(discovered, entry.modelId),
      );
  });
}

/**
 * Snapshot the most recent available binding when a chat is created.
 * Explicit drafts and existing session bindings keep their own selection.
 */
export function inheritedSessionModelBinding({
  draft,
  settings,
  providers,
  recentModels = [],
  discovered,
}: {
  draft?: SessionModelRef | null;
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
  recentModels?: readonly RecentModel[];
  discovered?: readonly ModelInfo[];
}): SessionModelRef {
  if (draft?.providerId && draft.modelId) {
    return { providerId: draft.providerId, modelId: draft.modelId };
  }
  const fallbackCandidates = providers.flatMap(provider =>
    (provider.models?.length ? provider.models.map(model => model.id) : [provider.defaultModelId])
      .filter((modelId): modelId is string => !!modelId)
      .map(modelId => ({ providerId: provider.id, modelId })),
  );
  const legacy = settings?.defaultProviderId && settings.defaultModelId
    ? [{ providerId: settings.defaultProviderId, modelId: settings.defaultModelId }]
    : [];
  const inherited = [...recentModels, ...legacy, ...fallbackCandidates].find(entry =>
    availableRecentModels([entry], providers, settings, discovered).length > 0,
  );
  const providerId = draft?.providerId ?? inherited?.providerId;
  const provider = providers.find((item) => item.id === providerId);
  const modelId =
    draft?.modelId ??
    (providerId === inherited?.providerId ? inherited?.modelId : undefined) ??
    provider?.defaultModelId ??
    provider?.models?.[0]?.id;
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** Newest transcript turn that already recorded a provider/model. */
export function lastUsedSessionModel(
  messages: readonly SessionModelRef[],
): SessionModelRef {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.modelId || message.providerId) {
      return {
        ...(message.providerId ? { providerId: message.providerId } : {}),
        ...(message.modelId ? { modelId: message.modelId } : {}),
      };
    }
  }
  return {};
}

export function sessionNeedsModelPin(
  session: SessionModelRef & { source?: string },
): boolean {
  if (session.source === "pi-native" || session.source === "remote") return false;
  return !session.providerId || !session.modelId;
}

/**
 * Durable snapshot for an unpinned session: last used turn, else the current
 * recent available model. Callers persist this so later selections cannot
 * rewrite an existing chat's binding.
 */
export function pinnedSessionModelBinding({
  session,
  messages,
  settings,
  providers,
  recentModels,
  discovered,
}: {
  session: SessionModelRef;
  messages?: readonly SessionModelRef[];
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
  recentModels?: readonly RecentModel[];
  discovered?: readonly ModelInfo[];
}): SessionModelRef {
  const used = lastUsedSessionModel(messages ?? []);
  return inheritedSessionModelBinding({
    draft: {
      providerId: session.providerId ?? used.providerId,
      modelId: session.modelId ?? used.modelId,
    },
    settings,
    providers,
    recentModels,
    discovered,
  });
}
