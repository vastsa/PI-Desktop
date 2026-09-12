import i18n from "i18next";
import type {
  AskToolResolution,
  PlanResolveRequest,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  headAsk,
  removeAsk,
} from "../../lib/pending-asks";
import {
  headPermission,
  removePermission,
} from "../../lib/pending-permissions";
import type { AppState, ToastOptions } from "../app-state";
import type { InteractionRuntime } from "../runtime/interaction-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

const PLAN_APPROVAL_TIMEOUT = "PLAN_APPROVAL_TIMEOUT";
const TOAST_DURATION_MS = 4000;
const TOAST_ERROR_DURATION_MS = 8000;
const TOAST_STACK_LIMIT = 4;

export type InteractionSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  interactionRuntime: InteractionRuntime;
};

export function createInteractionSlice({
  get,
  set,
  runtime,
  interactionRuntime,
}: InteractionSliceDependencies): Pick<
  AppState,
  | "setPage"
  | "setSettingsTab"
  | "setSettingsAnchor"
  | "canNavBack"
  | "canNavForward"
  | "navBack"
  | "navForward"
  | "resolvePermission"
  | "resolveAsk"
  | "resolvePlan"
  | "showToast"
  | "dismissToast"
> {
  return {
    setPage: (page, opts) => {
      runtime.beginNavigationIntent();
      const record = opts?.record !== false;
      set((state) => {
        if (!record) return { page };
        const entry = {
          page,
          sessionId: page === "chat" ? state.activeSessionId : undefined,
        };
        const stack = state.navStack.slice(0, state.navIndex + 1);
        const last = stack[stack.length - 1];
        const same =
          last?.page === entry.page && last?.sessionId === entry.sessionId;
        const nextStack = same ? stack : [...stack, entry].slice(-50);
        return {
          page,
          navStack: nextStack,
          navIndex: nextStack.length - 1,
        };
      });
    },

    setSettingsTab: (settingsTab) => {
      get().setPage("settings");
      set({ settingsTab });
    },
    setSettingsAnchor: (settingsAnchor) => set({ settingsAnchor }),
    canNavBack: () => get().navIndex > 0,
    canNavForward: () => get().navIndex < get().navStack.length - 1,

    navBack: () => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      if (state.navIndex <= 0) return;
      const index = state.navIndex - 1;
      const entry = state.navStack[index];
      set({ navIndex: index, page: entry.page });
      if (entry.page === "chat" && entry.sessionId) {
        void get().selectSession(entry.sessionId, {
          record: false,
          navigationIntent: intent,
        });
        set({ navIndex: index });
      }
    },

    navForward: () => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      if (state.navIndex >= state.navStack.length - 1) return;
      const index = state.navIndex + 1;
      const entry = state.navStack[index];
      set({ navIndex: index, page: entry.page });
      if (entry.page === "chat" && entry.sessionId) {
        void get().selectSession(entry.sessionId, {
          record: false,
          navigationIntent: intent,
        });
        set({ navIndex: index });
      }
    },

    resolvePermission: async (sessionId, requestId, decision) => {
      const permission = headPermission(get().pendingPermissions, sessionId);
      if (!permission || permission.requestId !== requestId) return;
      try {
        await api.resolvePermission({ requestId, decision });
      } finally {
        set((state) => ({
          pendingPermissions: removePermission(
            state.pendingPermissions,
            sessionId,
            requestId,
          ),
        }));
      }
    },

    resolveAsk: async (sessionId, resolution: AskToolResolution) => {
      const ask = headAsk(get().pendingAsks, sessionId);
      if (!ask || ask.requestId !== resolution.requestId) return;
      try {
        await api.resolveAskTool(resolution);
      } finally {
        set((state) => ({
          pendingAsks: removeAsk(
            state.pendingAsks,
            sessionId,
            resolution.requestId,
          ),
        }));
      }
    },

    resolvePlan: async (resolution: PlanResolveRequest) => {
      const activeRequest = interactionRuntime.planResolutionRequests.get(
        resolution.proposalId,
      );
      if (activeRequest) return activeRequest;
      const pending = get().pendingPlans[resolution.sessionId];
      if (
        !pending ||
        pending.status !== "pending" ||
        pending.id !== resolution.proposalId
      ) {
        throw new Error(i18n.t("errors.planApprovalUnavailable"));
      }
      const request = (async () => {
        try {
          const result = await api.resolvePlan(resolution);
          get().handlePlansChanged({
            sessionId: resolution.sessionId,
            state: result.state,
            proposal: result.proposal,
            proposalId: result.proposal.id,
            action: result.action,
            targetPermissionMode: result.targetPermissionMode,
          });
          return result;
        } catch (error) {
          if ((error as { code?: unknown })?.code === PLAN_APPROVAL_TIMEOUT) {
            await get().restorePendingPlan(resolution.sessionId);
          }
          throw error;
        }
      })();
      interactionRuntime.planResolutionRequests.set(
        resolution.proposalId,
        request,
      );
      try {
        return await request;
      } finally {
        if (
          interactionRuntime.planResolutionRequests.get(resolution.proposalId) ===
          request
        ) {
          interactionRuntime.planResolutionRequests.delete(resolution.proposalId);
        }
      }
    },

    showToast: (message, options) => {
      const variant = options?.variant ?? "info";
      const duration =
        options?.duration ??
        (variant === "error" ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS);
      set((state) => {
        const kept = state.toasts.filter(
          (item) => item.message !== message || item.variant !== variant,
        );
        const next = [
          ...kept,
          {
            id: interactionRuntime.nextToastId(),
            message,
            variant,
            duration,
          },
        ];
        return { toasts: next.slice(-TOAST_STACK_LIMIT) };
      });
    },
    dismissToast: (id) =>
      set((state) => ({
        toasts: state.toasts.filter((item) => item.id !== id),
      })),
  };
}
