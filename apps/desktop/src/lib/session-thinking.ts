/** Canonical ladder; keep in lockstep with `@pi-desktop/shared` THINKING_LEVELS. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type SessionThinkingSnapshot = {
  providerId?: string;
  modelId?: string;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  supportedThinkingLevels?: ThinkingLevel[];
};

export type OptimisticSessionConfiguration = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  mode?: unknown;
  permissionMode?: unknown;
};

export type ThinkingProviderLike = {
  id?: string;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: readonly ThinkingLevel[];
};

export function providerThinkingLevels(
  provider?: ThinkingProviderLike | null,
): ThinkingLevel[] {
  if (!provider?.supportsReasoning) return [];
  const declared = new Set(
    Array.isArray(provider.supportedThinkingLevels)
      ? provider.supportedThinkingLevels
      : [],
  );
  return THINKING_LEVELS.filter((level) => declared.has(level));
}

/**
 * Prefer a pinned session's enriched capabilities only when they actually
 * expose a thinking menu. Empty or `supportsReasoning: false` snapshots —
 * including unpinned sessions that Electron still degraded to `off` — must
 * not hide the selected model's catalog/binding levels.
 */
export function resolveComposerThinkingProvider<T extends ThinkingProviderLike>({
  provider,
  modelId,
  activeSession,
  catalogThinkingProvider,
}: {
  provider?: T | null;
  modelId?: string;
  activeSession?: SessionThinkingSnapshot | null;
  catalogThinkingProvider?: T | null;
}): T | null | undefined {
  const session = activeSession;
  const sessionThinkingProvider =
    provider &&
    session &&
    session.providerId === provider.id &&
    session.modelId === modelId &&
    typeof session.supportsReasoning === "boolean"
      ? {
          ...provider,
          supportsReasoning: session.supportsReasoning,
          supportedThinkingLevels: Array.isArray(session.supportedThinkingLevels)
            ? session.supportedThinkingLevels
            : (["off"] as ThinkingLevel[]),
        }
      : null;
  return sessionThinkingProvider &&
    providerThinkingLevels(sessionThinkingProvider).length > 0
    ? sessionThinkingProvider
    : catalogThinkingProvider;
}

/**
 * Optimistic next-turn pins must not keep capability fields computed for a
 * different (or unpinned) provider/model. Composer then falls back to the
 * catalog until `session.configure` returns a re-enriched snapshot.
 */
export function applyOptimisticSessionConfiguration<T extends SessionThinkingSnapshot>(
  session: T,
  config: OptimisticSessionConfiguration,
): T {
  const providerChanged =
    config.providerId !== undefined && config.providerId !== session.providerId;
  const modelChanged =
    config.modelId !== undefined && config.modelId !== session.modelId;
  const next = { ...session, ...config };
  if (!providerChanged && !modelChanged) return next;
  delete next.supportsReasoning;
  delete next.supportsVision;
  delete next.supportedThinkingLevels;
  return next;
}
