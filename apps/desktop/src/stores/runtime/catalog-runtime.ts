export type CatalogRuntime = {
  beginProviderRefresh: () => number;
  providerGeneration: () => number;
  /** Generation for notification list requests; newer mutations invalidate old reads. */
  notificationGeneration: () => number;
  invalidateNotificationRefresh: () => number;
  /** Notification ids acknowledged individually; bounded to avoid unbounded renderer state. */
  notificationReadIds: Set<string>;
  rememberNotificationRead: (id: string) => void;
  notificationReadBefore: () => number | null;
  setNotificationReadBefore: (timestamp: number) => void;
  notificationClearedAt: () => number | null;
  setNotificationClearedAt: (timestamp: number) => void;
  refreshedProviderModels: Set<string>;
  /** Failed live model discovery per provider: when the next attempt may run. */
  providerModelRetry: Map<string, ProviderModelRetry>;
  providerModelLoads: Map<string, Promise<void>>;
  getPluginRefresh: () => Promise<void> | null;
  setPluginRefresh: (request: Promise<void> | null) => void;
};

export type ProviderModelRetry = { failures: number; retryAt: number };

const PROVIDER_MODEL_RETRY_BASE_MS = 10_000;
const PROVIDER_MODEL_RETRY_MAX_MS = 5 * 60_000;

/**
 * Delay before live model discovery is tried again after `failures` failed
 * attempts. A transient failure is retried on a later menu open; an endpoint
 * that keeps failing (no /models route, bad key) backs off instead of being
 * probed on every open.
 */
export function providerModelRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 10));
  return Math.min(PROVIDER_MODEL_RETRY_BASE_MS * 2 ** exponent, PROVIDER_MODEL_RETRY_MAX_MS);
}

/** Coalesces catalog reads without putting mutable request state in the store. */
export function createCatalogRuntime(): CatalogRuntime {
  let providerModelsGeneration = 0;
  let notificationStateGeneration = 0;
  let notificationsReadBefore: number | null = null;
  let notificationsClearedAt: number | null = null;
  let pluginRefreshInFlight: Promise<void> | null = null;
  const refreshedProviderModels = new Set<string>();
  const providerModelRetry = new Map<string, ProviderModelRetry>();
  const providerModelLoads = new Map<string, Promise<void>>();
  const notificationReadIds = new Set<string>();

  const rememberNotificationRead = (id: string): void => {
    const normalized = id.trim();
    if (!normalized) return;
    notificationReadIds.delete(normalized);
    notificationReadIds.add(normalized);
    // Notification ids are durable, but this process only needs a bounded
    // replay guard. The host remains authoritative for older rows.
    while (notificationReadIds.size > 512) {
      const oldest = notificationReadIds.values().next().value;
      if (typeof oldest !== "string") break;
      notificationReadIds.delete(oldest);
    }
  };

  return {
    beginProviderRefresh: () => {
      providerModelsGeneration += 1;
      refreshedProviderModels.clear();
      providerModelRetry.clear();
      return providerModelsGeneration;
    },
    providerGeneration: () => providerModelsGeneration,
    notificationGeneration: () => notificationStateGeneration,
    invalidateNotificationRefresh: () => {
      notificationStateGeneration += 1;
      return notificationStateGeneration;
    },
    notificationReadIds,
    rememberNotificationRead,
    notificationReadBefore: () => notificationsReadBefore,
    setNotificationReadBefore: (timestamp) => {
      if (!Number.isFinite(timestamp)) return;
      notificationsReadBefore = Math.max(notificationsReadBefore ?? 0, timestamp);
    },
    notificationClearedAt: () => notificationsClearedAt,
    setNotificationClearedAt: (timestamp) => {
      if (!Number.isFinite(timestamp)) return;
      notificationsClearedAt = Math.max(notificationsClearedAt ?? 0, timestamp);
    },
    refreshedProviderModels,
    providerModelRetry,
    providerModelLoads,
    getPluginRefresh: () => pluginRefreshInFlight,
    setPluginRefresh: (request) => {
      pluginRefreshInFlight = request;
    },
  };
}
