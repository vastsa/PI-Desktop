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
  providerModelLoads: Map<string, Promise<void>>;
  getPluginRefresh: () => Promise<void> | null;
  setPluginRefresh: (request: Promise<void> | null) => void;
};

/** Coalesces catalog reads without putting mutable request state in the store. */
export function createCatalogRuntime(): CatalogRuntime {
  let providerModelsGeneration = 0;
  let notificationStateGeneration = 0;
  let notificationsReadBefore: number | null = null;
  let notificationsClearedAt: number | null = null;
  let pluginRefreshInFlight: Promise<void> | null = null;
  const refreshedProviderModels = new Set<string>();
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
    providerModelLoads,
    getPluginRefresh: () => pluginRefreshInFlight,
    setPluginRefresh: (request) => {
      pluginRefreshInFlight = request;
    },
  };
}
