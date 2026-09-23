import type {
  AppNotification,
  ModelInfo,
  ProviderPublic,
  SessionSummary,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { latestSessionOutcomes } from "../../lib/sidebar-session-status";
import type { AppState } from "../app-state";
import type { CatalogRuntime } from "../runtime/catalog-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

export type CatalogSliceDependencies = StoreAccess & {
  catalogRuntime: CatalogRuntime;
  sessionRuntime: SessionRuntime;
  decorateSessions: (
    sessions: SessionSummary[],
    meta: AppState["sessionMeta"],
  ) => SessionSummary[];
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
};

export function createCatalogSlice({
  get,
  set,
  catalogRuntime,
  sessionRuntime,
  decorateSessions,
  withoutRecordKey,
}: CatalogSliceDependencies): Pick<
  AppState,
  | "refreshProviders"
  | "loadProviderModels"
  | "refreshPlugins"
  | "refreshPluginThemes"
  | "refreshPluginViews"
  | "refreshNotifications"
  | "receiveNotification"
  | "markNotificationRead"
  | "markAllNotificationsRead"
  | "clearNotifications"
  | "openNotification"
  | "acknowledgeSessionOutcome"
> {
  return {
    refreshProviders: async () => {
      const generation = catalogRuntime.beginProviderRefresh();
      const [providers, sessions, settings, onboarding] = await Promise.all([
        api.listProviders(),
        api.listSessions(),
        api.getSettings(),
        api.getOnboarding(),
      ]);
      if (generation !== catalogRuntime.providerGeneration()) return;
      set((state) => ({
        providers: providers.providers,
        providerModels: {},
        sessions: decorateSessions(sessions.sessions, state.sessionMeta),
        settings,
        onboarding,
      }));
    },

    loadProviderModels: async (providerId) => {
      const { refreshedProviderModels, providerModelLoads } = catalogRuntime;
      if (refreshedProviderModels.has(providerId)) return;
      const generation = catalogRuntime.providerGeneration();
      const existing = providerModelLoads.get(providerId);
      if (existing) {
        await existing;
        if (providerModelLoads.get(providerId) === existing) {
          providerModelLoads.delete(providerId);
        }
        if (!refreshedProviderModels.has(providerId)) {
          await get().loadProviderModels(providerId);
        }
        return;
      }

      const load = (async () => {
        let hydrated = (get().providerModels[providerId]?.length ?? 0) > 0;
        if (!hydrated) {
          try {
            const cached = await api.listProviderModels({
              providerId,
              source: "cache",
            });
            if (generation !== catalogRuntime.providerGeneration()) return;
            hydrated = cached.models.length > 0;
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: cached.models,
              },
            }));
          } catch {
            // Continue to live discovery when the local cache is unavailable.
          }
        }

        try {
          const refreshed = await api.listProviderModels({
            providerId,
            source: "refresh",
          });
          if (generation !== catalogRuntime.providerGeneration()) return;
          if (
            (refreshed.source === "remote" || refreshed.source === "catalog") &&
            refreshed.models.length > 0
          ) {
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: refreshed.models,
              },
            }));
          } else if (!hydrated && refreshed.models.length > 0) {
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: refreshed.models,
              },
            }));
          }
        } catch {
          // Keep the cached catalog; the menu already has a usable fallback.
        } finally {
          if (generation === catalogRuntime.providerGeneration()) {
            refreshedProviderModels.add(providerId);
          }
        }
      })();
      providerModelLoads.set(providerId, load);
      try {
        await load;
      } finally {
        if (providerModelLoads.get(providerId) === load) {
          providerModelLoads.delete(providerId);
        }
      }
    },

    refreshPlugins: async () => {
      const existing = catalogRuntime.getPluginRefresh();
      if (existing) return existing;
      const load = (async () => {
        const plugins = await api.listPlugins();
        set({ plugins: plugins.plugins });
      })();
      catalogRuntime.setPluginRefresh(load);
      try {
        await load;
      } finally {
        if (catalogRuntime.getPluginRefresh() === load) {
          catalogRuntime.setPluginRefresh(null);
        }
      }
    },

    refreshPluginThemes: async () => {
      try {
        set({ pluginThemes: await api.listPluginThemes() });
      } catch {
        set({ pluginThemes: [] });
      }
    },

    refreshPluginViews: async () => {
      try {
        set({ pluginViews: await api.listPluginViews() });
      } catch {
        set({ pluginViews: [] });
      }
    },

    refreshNotifications: async () => {
      const generation = catalogRuntime.notificationGeneration();
      const result = await api.listNotifications({ limit: 200 });
      if (generation !== catalogRuntime.notificationGeneration()) return;
      const clearedAt = catalogRuntime.notificationClearedAt();
      const readBefore = catalogRuntime.notificationReadBefore();
      const readIds = catalogRuntime.notificationReadIds;
      const touchedSessionIds = new Set(
        result.notifications.map((notification) => notification.sessionId),
      );
      const notifications = result.notifications
        .filter((notification) => {
          const createdAt = Date.parse(notification.createdAt);
          return !(
            clearedAt !== null &&
            Number.isFinite(createdAt) &&
            createdAt <= clearedAt
          );
        })
        .map((notification) => {
          const createdAt = Date.parse(notification.createdAt);
          const acknowledgedById = readIds.has(notification.id);
          const acknowledgedByTime =
            readBefore !== null &&
            Number.isFinite(createdAt) &&
            createdAt <= readBefore;
          if (
            (acknowledgedById || acknowledgedByTime) &&
            !notification.readAt
          ) {
            const acknowledgedAt =
              acknowledgedByTime && readBefore !== null
                ? readBefore
                : Date.now();
            return {
              ...notification,
              readAt: new Date(acknowledgedAt).toISOString(),
            };
          }
          return notification;
        });
      const rawUnreadCount = result.notifications.reduce(
        (count, notification) => count + (notification.readAt ? 0 : 1),
        0,
      );
      const effectiveUnreadCount = notifications.reduce(
        (count, notification) => count + (notification.readAt ? 0 : 1),
        0,
      );
      set((state) => {
        const sessionOutcomes = { ...state.sessionOutcomes };
        for (const sessionId of touchedSessionIds) {
          delete sessionOutcomes[sessionId];
        }
        Object.assign(sessionOutcomes, latestSessionOutcomes(notifications));
        return {
          notifications,
          // Host count includes rows hidden by a local acknowledgement
          // watermark; adjust only for rows present in this response.
          unreadNotificationCount: Math.max(
            0,
            result.unreadCount - rawUnreadCount + effectiveUnreadCount,
          ),
          sessionOutcomes,
        };
      });
    },

    receiveNotification: (notification: AppNotification) => {
      const createdAt = Date.parse(notification.createdAt);
      const clearedAt = catalogRuntime.notificationClearedAt();
      const readBefore = catalogRuntime.notificationReadBefore();
      if (
        !Number.isFinite(createdAt) ||
        catalogRuntime.notificationReadIds.has(notification.id) ||
        (clearedAt !== null && createdAt <= clearedAt) ||
        (readBefore !== null && createdAt <= readBefore) ||
        get().notifications.some((item) => item.id === notification.id)
      ) {
        return false;
      }
      // A notification event is a state mutation too. Invalidate any list
      // request that was already in flight so its older snapshot cannot erase
      // this newly accepted row when it resolves.
      catalogRuntime.invalidateNotificationRefresh();
      set((state) => {
        const notifications = [notification, ...state.notifications].slice(0, 200);
        return {
          notifications,
          sessionOutcomes: {
            ...state.sessionOutcomes,
            [notification.sessionId]:
              notification.kind === "task.failed" ? "failed" : "completed",
          },
          unreadNotificationCount:
            state.unreadNotificationCount + (notification.readAt ? 0 : 1),
        };
      });
      return true;
    },

    markNotificationRead: async (id) => {
      const item = get().notifications.find((notification) => notification.id === id);
      if (!item || item.readAt) return;
      const generation = catalogRuntime.invalidateNotificationRefresh();
      try {
        await api.markNotificationRead(id);
      } catch (error) {
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      catalogRuntime.rememberNotificationRead(id);
      const readAt = new Date().toISOString();
      set((state) => {
        const notifications = state.notifications.map((notification) =>
          notification.id === id ? { ...notification, readAt } : notification,
        );
        const sessionId = state.notifications.find(
          (notification) => notification.id === id,
        )?.sessionId;
        const sessionOutcomes = { ...state.sessionOutcomes };
        if (sessionId) {
          delete sessionOutcomes[sessionId];
          Object.assign(
            sessionOutcomes,
            latestSessionOutcomes(
              notifications.filter(
                (notification) => notification.sessionId === sessionId,
              ),
            ),
          );
        }
        return {
          notifications,
          unreadNotificationCount: Math.max(
            0,
            state.unreadNotificationCount - 1,
          ),
          sessionOutcomes,
        };
      });
    },

    markAllNotificationsRead: async () => {
      if (get().unreadNotificationCount === 0) return;
      const acknowledgedIds = new Set(
        get()
          .notifications.filter((notification) => !notification.readAt)
          .map((notification) => notification.id),
      );
      const requestedAt = Date.now();
      const generation = catalogRuntime.invalidateNotificationRefresh();
      try {
        await api.markAllNotificationsRead();
      } catch (error) {
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      const readAtMs = requestedAt;
      const readAt = new Date(readAtMs).toISOString();
      for (const id of acknowledgedIds) {
        catalogRuntime.rememberNotificationRead(id);
      }
      catalogRuntime.setNotificationReadBefore(readAtMs);
      set((state) => {
        const notifications = state.notifications.map((notification) =>
          notification.readAt || !acknowledgedIds.has(notification.id)
            ? notification
            : { ...notification, readAt },
        );
        const acknowledgedSessionIds = new Set(
          state.notifications
            .filter((notification) => acknowledgedIds.has(notification.id))
            .map((notification) => notification.sessionId),
        );
        const sessionOutcomes = { ...state.sessionOutcomes };
        for (const sessionId of acknowledgedSessionIds) {
          delete sessionOutcomes[sessionId];
        }
        Object.assign(
          sessionOutcomes,
          latestSessionOutcomes(
            notifications.filter((notification) =>
              acknowledgedSessionIds.has(notification.sessionId),
            ),
          ),
        );
        return {
          notifications,
          unreadNotificationCount: notifications.reduce(
            (count, notification) => count + (notification.readAt ? 0 : 1),
            0,
          ),
          sessionOutcomes,
        };
      });
    },

    clearNotifications: async () => {
      const requestedAt = Date.now();
      const generation = catalogRuntime.invalidateNotificationRefresh();
      try {
        await api.clearNotifications();
      } catch (error) {
        // A failed clear must leave the local inbox usable. The generation
        // invalidation above intentionally discards any older list response;
        // fetch a current snapshot before surfacing the original error.
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      catalogRuntime.setNotificationClearedAt(requestedAt);
      catalogRuntime.setNotificationReadBefore(requestedAt);
      set({ notifications: [], unreadNotificationCount: 0, sessionOutcomes: {} });
      // A turn that completed after the clear began is a legitimate new result.
      // Reconcile once so it is not lost if its event raced the clear request.
      await get().refreshNotifications();
    },

    openNotification: async (id) => {
      const intent = sessionRuntime.beginNavigationIntent();
      const notification = get().notifications.find((item) => item.id === id);
      if (!notification) return;
      await get().markNotificationRead(id);
      if (!sessionRuntime.navigationIntentIsCurrent(intent)) return;
      await get().selectSession(notification.sessionId, {
        navigationIntent: intent,
      });
    },

    acknowledgeSessionOutcome: async (sessionId) => {
      set((state) =>
        state.sessionOutcomes[sessionId]
          ? { sessionOutcomes: withoutRecordKey(state.sessionOutcomes, sessionId) }
          : {},
      );
      const unread = get().notifications.filter(
        (item) => item.sessionId === sessionId && !item.readAt,
      );
      for (const item of unread) {
        await get().markNotificationRead(item.id);
      }
    },
  };
}
