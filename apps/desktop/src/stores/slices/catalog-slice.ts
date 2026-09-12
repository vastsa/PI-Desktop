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
      const [providers, sessions, settings, onboarding] = await Promise.all([
        api.listProviders(),
        api.listSessions(),
        api.getSettings(),
        api.getOnboarding(),
      ]);
      catalogRuntime.beginProviderRefresh();
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
      const result = await api.listNotifications({ limit: 200 });
      set((state) => ({
        notifications: result.notifications,
        unreadNotificationCount: result.unreadCount,
        sessionOutcomes: {
          ...state.sessionOutcomes,
          ...latestSessionOutcomes(result.notifications),
        },
      }));
    },

    receiveNotification: (notification: AppNotification) => {
      set((state) => {
        const withoutCurrent = state.notifications.filter(
          (item) => item.id !== notification.id,
        );
        const notifications = [notification, ...withoutCurrent].slice(0, 200);
        return {
          notifications,
          sessionOutcomes: {
            ...state.sessionOutcomes,
            [notification.sessionId]:
              notification.kind === "task.failed" ? "failed" : "completed",
          },
          unreadNotificationCount: notifications.reduce(
            (count, item) => count + (item.readAt ? 0 : 1),
            0,
          ),
        };
      });
    },

    markNotificationRead: async (id) => {
      const item = get().notifications.find((notification) => notification.id === id);
      if (!item || item.readAt) return;
      await api.markNotificationRead(id);
      const readAt = new Date().toISOString();
      set((state) => ({
        notifications: state.notifications.map((notification) =>
          notification.id === id ? { ...notification, readAt } : notification,
        ),
        unreadNotificationCount: Math.max(0, state.unreadNotificationCount - 1),
      }));
    },

    markAllNotificationsRead: async () => {
      if (get().unreadNotificationCount === 0) return;
      await api.markAllNotificationsRead();
      const readAt = new Date().toISOString();
      set((state) => ({
        notifications: state.notifications.map((notification) =>
          notification.readAt ? notification : { ...notification, readAt },
        ),
        unreadNotificationCount: 0,
      }));
    },

    clearNotifications: async () => {
      await api.clearNotifications();
      set({ notifications: [], unreadNotificationCount: 0 });
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
