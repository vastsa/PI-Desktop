import type { WindowLifecycleState } from "./window";
import {
  baseWindowBounds,
  emptyWorkPanelReservationState,
  reconcileBaseWindowBounds,
  type DisplayTransition,
  type WindowBounds,
  type WorkPanelReservationState,
} from "../work-panel-window";

export type WorkPanelRuntimeDependencies = {
  state: WindowLifecycleState;
  windowMinWidth: number;
  chatResizeSettleMs: number;
};

export function createWorkPanelRuntime({
  state,
  windowMinWidth,
  chatResizeSettleMs,
}: WorkPanelRuntimeDependencies) {
  const workPanelMinimumWindowWidth = () =>
    windowMinWidth + state.workPanelReservation.width;

  const observedWorkPanelBaseBounds = (
    currentBounds: WindowBounds,
    displayTransition: DisplayTransition,
  ): WindowBounds => {
    if (!state.workPanelBaseBounds || !state.workPanelLastAppliedBounds) {
      return baseWindowBounds(currentBounds, state.workPanelReservation);
    }
    return reconcileBaseWindowBounds({
      baseBounds: state.workPanelBaseBounds,
      lastAppliedBounds: state.workPanelLastAppliedBounds,
      currentBounds,
      displayTransition,
      reservation: state.workPanelReservation,
    });
  };

  const markWorkPanelChatResizeActive = () => {
    state.workPanelChatResizeActive = true;
    if (state.workPanelChatResizeTimer) {
      clearTimeout(state.workPanelChatResizeTimer);
    }
    state.workPanelChatResizeTimer = setTimeout(() => {
      state.workPanelChatResizeTimer = null;
      state.workPanelChatResizeActive = false;
    }, chatResizeSettleMs);
  };

  const classifyDisplayTransition = (
    nextDisplayKey: string,
  ): DisplayTransition => {
    if (
      state.workPanelDisplayKey === null ||
      nextDisplayKey === state.workPanelDisplayKey
    ) {
      return "none";
    }
    return state.workPanelUserMovePending ? "user-moved" : "os-adjusted";
  };

  const applyWorkPanelReservation = (): WorkPanelReservationState => {
    // The work panel is rendered inside the existing BrowserWindow. Opening or
    // collapsing the panel must never mutate native bounds.
    state.requestedWorkPanelReservation = 0;
    state.workPanelReservation = emptyWorkPanelReservationState();
    return state.workPanelReservation;
  };

  return {
    workPanelMinimumWindowWidth,
    observedWorkPanelBaseBounds,
    markWorkPanelChatResizeActive,
    classifyDisplayTransition,
    applyWorkPanelReservation,
  };
}
