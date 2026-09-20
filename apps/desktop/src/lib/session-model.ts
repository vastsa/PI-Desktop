/** Resolve the provider/model a session should keep after first selection. */

export type SessionModelRef = {
  providerId?: string;
  modelId?: string;
};

export type SessionModelProvider = {
  id: string;
  defaultModelId?: string;
  models?: Array<{ id: string }>;
};

export type SessionModelSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
};

/**
 * App default (or an explicit draft override) at the moment a session is
 * created. Later Settings default-model changes must not rewrite this pair.
 */
export function inheritedSessionModelBinding({
  draft,
  settings,
  providers,
}: {
  draft?: SessionModelRef | null;
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
}): SessionModelRef {
  const providerId = draft?.providerId ?? settings?.defaultProviderId;
  const provider = providers.find((item) => item.id === providerId);
  const modelId =
    draft?.modelId ??
    settings?.defaultModelId ??
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
 * app default. Callers persist this so the session stops following Settings.
 */
export function pinnedSessionModelBinding({
  session,
  messages,
  settings,
  providers,
}: {
  session: SessionModelRef;
  messages?: readonly SessionModelRef[];
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
}): SessionModelRef {
  const used = lastUsedSessionModel(messages ?? []);
  return inheritedSessionModelBinding({
    draft: {
      providerId: session.providerId ?? used.providerId,
      modelId: session.modelId ?? used.modelId,
    },
    settings,
    providers,
  });
}
