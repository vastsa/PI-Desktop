import { create } from "zustand";
import type {
  AppSettings,
  ModelInfo,
  PlanningState,
} from "@pi-desktop/shared";
import {
  migrateKeybindingOverrides,
  normalizeMode,
  PROTOCOL_VERSION,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { rememberProject } from "../lib/recent-projects";
import {
  RETAINED_SESSION_PANE_LIMIT,
  clearSessionPanes,
} from "../lib/session-panes";
import {
  latestSessionOutcomes,
} from "../lib/sidebar-session-status";
import {
  projectWorkspaceFromPath,
  saveSidebarPreferences,
} from "../lib/sidebar-preferences";
import {
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../lib/work-panel-resize";
import {
  isPendingPlan,
  latestPlanProposal,
} from "../lib/plan-mode-state";
import { settleBootstrapRequests } from "../lib/bootstrap-result";
import {
  createSessionRuntime,
  type SessionRuntime,
} from "./runtime/session-runtime";
import type { StoreAccess } from "./slices/types";
import {
  createWorkPanelSlice,
  switchWorkPanelSession,
} from "./slices/work-panel-slice";
import {
  createInitialState,
  initialSidebarPreferences,
} from "./slices/initial-state";
import { createSessionSlice } from "./slices/session-slice";
import { createQueueSlice } from "./slices/queue-slice";
import { createTranscriptSlice } from "./slices/transcript-slice";
import { createProjectSlice } from "./slices/project-slice";
import { createCatalogSlice } from "./slices/catalog-slice";
import { createEventsSlice } from "./slices/events-slice";
import { createInteractionSlice } from "./slices/interaction-slice";
import {
  createCatalogRuntime,
  type CatalogRuntime,
} from "./runtime/catalog-runtime";
import {
  createSessionCoordination,
  type SessionCoordination,
} from "./runtime/session-coordination";
import {
  createInteractionRuntime,
  type InteractionRuntime,
} from "./runtime/interaction-runtime";
import {
  createSessionTitleRuntime,
  isDefaultSessionTitle,
  promptFallbackSessionTitle,
  untitledTaskTitle,
} from "./runtime/session-title-runtime";
import { createInteractivePromptNotifier } from "./runtime/notification-runtime";
import { createTranscriptReadingRuntime } from "./runtime/transcript-reading-runtime";
export type {
  AgentTurnResult,
  DraftSessionConfiguration,
  PendingPlanRefreshResult,
  ToastItem,
  ToastOptions,
  ToastVariant,
} from "./app-state";
export { isDefaultSessionTitle } from "./runtime/session-title-runtime";

export type { WorkPanelTab } from "../lib/work-panel-tabs";

import {
  promptAttachmentsFromDraft,
  promptAttachmentsFromMessage,
  withoutRecordKey,
  viewingSessionIdForPrompt,
  messageErrorFromUnknown,
  assistantErrorMessage,
  sessionModeForPlanningState,
  openPlanArtifact,
  decorateSessions,
  promoteProjectPath,
  removeProjectPath,
  upsertWorkspace,
  withProjectDisplayName,
  preferencesFromState,
  withCompactionMark,
} from "./helpers/store-helpers";

export type AppState = import("./app-state").AppState;

export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;
export { RETAINED_SESSION_PANE_LIMIT };
export { WORK_PANEL_DEFAULT_WIDTH, WORK_PANEL_MIN_WIDTH };

function persistCurrentSidebar(getState: () => AppState): void {
  saveSidebarPreferences(preferencesFromState(getState()));
}

let storeAccess: StoreAccess | null = null;
const runtimeStoreAccess: StoreAccess = {
  get: () => {
    if (!storeAccess) throw new Error("App store is not initialized");
    return storeAccess.get();
  },
  set: (update) => {
    if (!storeAccess) throw new Error("App store is not initialized");
    storeAccess.set(update);
  },
};
const sessionRuntime: SessionRuntime = createSessionRuntime(runtimeStoreAccess);
const catalogRuntime: CatalogRuntime = createCatalogRuntime();
const interactionRuntime: InteractionRuntime = createInteractionRuntime();
const titleRuntime = createSessionTitleRuntime({
  ...runtimeStoreAccess,
  sessionRuntime,
  initialSessionMeta: initialSidebarPreferences.sessionMeta,
});
const manuallyRenamedSessionIds = titleRuntime.manualSessionTitles;
const { triggerAutoTitleSummarization } = titleRuntime;
const notifyInteractivePrompt = createInteractivePromptNotifier(
  runtimeStoreAccess.get,
);
const sessionCoordination: SessionCoordination = createSessionCoordination({
  ...runtimeStoreAccess,
  runtime: sessionRuntime,
  decorateSessions,
  withoutRecordKey,
  untitledTaskTitle,
});
const {
  flushPendingSessionConfiguration,
  rememberSessionCompactions,
  commitForkedSession,
  persistSessionAndSelect,
  materializeDraftSession: materializeDraftSessionInternal,
} = sessionCoordination;

const transcriptReading = createTranscriptReadingRuntime(runtimeStoreAccess, api.getSession);

/**
 * Which `bootstrap` attempt owns the state it publishes.
 *
 * The renderer's startup is retryable now (issue #831), and the attempt it
 * retries is usually one that never settled: without this, that older attempt
 * could land after the retry already published the shell and reset the view the
 * user is working in (`activeSessionId`, `messages`, `page`, panes).
 */
let bootstrapGeneration = 0;

export const useAppStore = create<AppState>((set, get) => {
  storeAccess = { get, set };
  return {
  ...createInitialState(),
  ...transcriptReading.actions,

  ...createSessionSlice({
    get,
    set,
    runtime: sessionRuntime,
    decorateSessions,
    withoutRecordKey,
    sessionModeForPlanningState,
    openPlanArtifact,
    rememberSessionCompactions,
    commitForkedSession,
    persistSessionAndSelect,
  }),

  ...createQueueSlice({
    get,
    set,
    runtime: sessionRuntime,
    promptAttachmentsFromDraft,
    withoutRecordKey,
    promptFallbackSessionTitle,
    untitledTaskTitle,
    isDefaultSessionTitle,
    viewingSessionIdForPrompt,
    messageErrorFromUnknown,
    assistantErrorMessage,
    materializeDraftSession: materializeDraftSessionInternal,
  }),

  ...createTranscriptSlice({
    get,
    set,
    runtime: sessionRuntime,
    promptAttachmentsFromMessage,
    viewingSessionIdForPrompt,
    flushPendingSessionConfiguration,
  }),

  ...createProjectSlice({
    get,
    set,
    runtime: sessionRuntime,
    manualSessionTitles: manuallyRenamedSessionIds,
    withoutRecordKey,
    withProjectDisplayName,
    promoteProjectPath,
    removeProjectPath,
    upsertWorkspace,
    persistCurrentSidebar,
  }),

  ...createCatalogSlice({
    get,
    set,
    catalogRuntime,
    sessionRuntime,
    decorateSessions,
    withoutRecordKey,
  }),

  ...createEventsSlice({
    get,
    set,
    runtime: sessionRuntime,
    withoutRecordKey,
    sessionModeForPlanningState,
    openPlanArtifact,
    notifyInteractivePrompt,
    triggerAutoTitleSummarization,
    flushPendingSessionConfiguration,
    assistantErrorMessage,
    withCompactionMark,
  }),

  ...createInteractionSlice({
    get,
    set,
    runtime: sessionRuntime,
    interactionRuntime,
  }),

  bootstrap: async () => {
    // Only the newest attempt may publish; an older in-flight one returns
    // without touching the store.
    const generation = ++bootstrapGeneration;
    let recoveredSettings: AppSettings | undefined;
    try {
      const settingsRequest = api.getSettings().then(async (settingsRaw) => {
        let settings = settingsRaw
          ? {
              ...settingsRaw,
              defaultMode: normalizeMode(
                (settingsRaw as { defaultMode?: unknown }).defaultMode,
              ),
              // Persisted keybindings can still name the retired window ids
              // (D438); every renderer reader sees the folded map, and the next
              // shortcut save writes that shape back.
              keybindings: migrateKeybindingOverrides(settingsRaw.keybindings),
            }
          : settingsRaw;
        // First-run default per D003: Agent. Never force-rewrite an existing
        // user choice on boot.
        if (settings && !settings.defaultMode) {
          const next = { ...settings, defaultMode: "agent" as const };
          try {
            await api.setSettings(next);
            settings = next;
          } catch {
            settings = next;
          }
        }
        return settings;
      });
      const snapshotRequest = Promise.all([
        api.getVersion(),
        api.health(),
        api.listSessions(),
        api.listProviders(),
        api.getProject(),
        api.getOnboarding(),
        api.listPlugins(),
        api.listNotifications({ limit: 200 }),
        api.pendingPlans(),
      ]);
      const bootstrapResult = await settleBootstrapRequests(
        settingsRequest,
        snapshotRequest,
      );
      recoveredSettings = bootstrapResult.settings;
      if (!bootstrapResult.ok) {
        throw bootstrapResult.error;
      }
      const settings = bootstrapResult.settings;
      const [
        version,
        health,
        sessions,
        providers,
        project,
        onboarding,
        plugins,
        notifications,
        pendingPlansResult,
      ] = bootstrapResult.snapshot;
      if (version.protocolVersion !== PROTOCOL_VERSION) {
        set({
          error: `Protocol mismatch: UI ${PROTOCOL_VERSION} vs app ${version.protocolVersion}`,
          errorCode: "PROTOCOL_MISMATCH",
        });
      }
      const cachedProviderModels = Object.fromEntries(
        (
          await Promise.all(
            providers.providers.map(async (provider) => {
              try {
                const cached = await api.listProviderModels({
                  providerId: provider.id,
                  source: "cache",
                });
                return cached.models.length > 0
                  ? ([provider.id, cached.models] as const)
                  : null;
              } catch {
                return null;
              }
            }),
          )
        ).filter((entry): entry is readonly [string, ModelInfo[]] => entry !== null),
      );
      const currentWorkspace = project.workspace
        ? withProjectDisplayName(project.workspace, get().projectMeta)
        : null;
      const persistedPaths = get().openProjectPaths;
      // Only explicitly retained tabs are restored. Historical sessions stay
      // available in Projects, but must not silently reopen a tab that was
      // intentionally closed.
      const openProjectPaths = currentWorkspace?.path
        ? promoteProjectPath(persistedPaths, currentWorkspace.path)
        : persistedPaths;
      const openProjects = openProjectPaths.map((path) =>
        withProjectDisplayName(projectWorkspaceFromPath(path), get().projectMeta),
      );
      const hydratedProjects = currentWorkspace
        ? upsertWorkspace(openProjects, currentWorkspace)
        : openProjects;
      const hydratedSessions = decorateSessions(sessions.sessions, get().sessionMeta);
      const latestPlanCheckpoints = Object.fromEntries(
        hydratedSessions.flatMap((session) => {
          const proposal = latestPlanProposal(
            pendingPlansResult.plans,
            session.id,
          );
          return proposal ? [[session.id, proposal] as const] : [];
        }),
      );
      const activePendingPlans = pendingPlansResult.plans.filter(isPendingPlan);
      const pendingPlans = Object.fromEntries(
        activePendingPlans.map((proposal) => [proposal.sessionId, proposal]),
      );
      const planningStates: Record<string, PlanningState> = Object.fromEntries(
        hydratedSessions.map((session) => [
          session.id,
          session.mode === "plan" ? ("planning" as const) : ("inactive" as const),
        ]),
      );
      for (const proposal of activePendingPlans) {
        planningStates[proposal.sessionId] = "awaiting_approval";
      }
      if (generation !== bootstrapGeneration) return;
      set({
        ready: true,
        version,
        healthOk: health.ok,
        settings,
        sessions: hydratedSessions,
        providers: providers.providers,
        providerModels: cachedProviderModels,
        workspace: currentWorkspace,
        activeProjectPath: currentWorkspace?.path,
        openProjectPaths,
        openProjects: hydratedProjects,
        onboarding,
        plugins: plugins.plugins,
        planningStates,
        pendingPlans,
        planCheckpoints: latestPlanCheckpoints,
        notifications: notifications.notifications,
        unreadNotificationCount: notifications.unreadCount,
        sessionOutcomes: latestSessionOutcomes(notifications.notifications),
      });

      // The artifact's surface depends on which plugin views are launchable, and
      // the launcher list is only read after `ready`. Resolve it before the
      // restore, so the approval artifact does not fall back to the host file tab
      // and then take a second tab from `selectSession`.
      await get().refreshPluginViews();
      for (const proposal of activePendingPlans) {
        openPlanArtifact(
          proposal,
          get().openWorkPanelTabForSession,
          get().pluginViews,
        );
      }
      saveSidebarPreferences(preferencesFromState(get()));
      if (currentWorkspace?.path) {
        rememberProject({
          path: currentWorkspace.path,
          name: currentWorkspace.name || currentWorkspace.path,
          branch: currentWorkspace.branch,
        });
      }
      // Codex opens an empty draft home ("What can I help you build?") rather than
      // restoring a prior transcript as the first paint. A live host plan is
      // the exception: its owning session must be visible so approval can be
      // restored after a renderer reload.
      const livePlanSessionId = activePendingPlans[0]?.sessionId;
      if (livePlanSessionId) {
        await get().selectSession(livePlanSessionId);
      } else {
        // App startup keeps the home composer unpersisted. Explicit New Task
        // actions use the durable empty-session slot below, but launch itself
        // must not create a history row merely because the app was opened.
        set((s) => {
          const stack = s.navStack.slice(0, s.navIndex + 1);
          const nextStack = [...stack, { page: "chat" as const }].slice(-50);
          return {
            ...switchWorkPanelSession(s, undefined),
            ...clearSessionPanes(),
            activeSessionId: undefined,
            draftConfiguration: null,
            messages: [],
            page: "chat" as const,
            navStack: nextStack,
            navIndex: nextStack.length - 1,
            isRunning: false,
          };
        });
      }
    } catch (e) {
      // A superseded attempt reports nothing: its failure belongs to a wait the
      // user already left behind.
      if (generation !== bootstrapGeneration) return;
      set({
        ready: true,
        healthOk: false,
        ...(recoveredSettings ? { settings: recoveredSettings } : {}),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  ...createWorkPanelSlice({
    get,
    set,
    isSessionSelectionPending: (sessionId) =>
      sessionRuntime.isSessionSelectionPending(sessionId),
  }),


  clearComposerPrefill: () => set({ composerPrefill: null }),
  };
});

/** Reconcile reading views and canonical caches at the same publication boundary. */
useAppStore.subscribe((state, previous) => {
  transcriptReading.reconcile(state, previous);
  sessionRuntime.syncTranscriptProjection(state, previous);
});

export async function materializeDraftSession(
  intent?: number,
): Promise<string | null> {
  return sessionCoordination.materializeDraftSession(intent);
}
