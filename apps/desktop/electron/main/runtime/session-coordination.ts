import type { BrowserWindow } from "electron";
import {
  addUsage,
  type MessageUsage,
} from "@pi-desktop/shared";
import {
  shouldCreateTaskNotification as shouldCreateTaskNotificationPolicy,
} from "../notification-policy";

export type SessionCoordinationDependencies = {
  activeTurns: Map<string, string>;
  getMainWindow: () => BrowserWindow | null;
  getViewingSessionId: () => string | null;
};

export function createSessionCoordination({
  activeTurns,
  getMainWindow,
  getViewingSessionId,
}: SessionCoordinationDependencies) {
  const sessionOperationTails = new Map<string, Promise<void>>();
  const turnSettlements = new Map<string, Set<() => void>>();
  const activeTurnUsages = new Map<string, MessageUsage>();

  async function acquireSessionOperation(sessionId: string): Promise<() => void> {
    const id = sessionId.trim();
    const previous = sessionOperationTails.get(id) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const tail = previous.then(() => current);
    sessionOperationTails.set(id, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (sessionOperationTails.get(id) === tail) {
        sessionOperationTails.delete(id);
      }
    };
  }

  function addActiveTurnUsage(
    sessionId: string,
    usage: MessageUsage | undefined,
  ): void {
    if (!usage) return;
    const next = addUsage(activeTurnUsages.get(sessionId), usage);
    if (next) activeTurnUsages.set(sessionId, next);
  }

  const activeToolCallKey = (sessionId: string, toolCallId: string) =>
    sessionId + ":" + toolCallId;

  const planSubmissionTurnKey = (sessionId: string, turnId: string) =>
    sessionId + ":" + turnId;

  function waitForTurnSettlement(sessionId: string, turnId: string): Promise<void> {
    if (activeTurns.get(sessionId) !== turnId) return Promise.resolve();
    const key = planSubmissionTurnKey(sessionId, turnId);
    return new Promise((resolve) => {
      const waiters = turnSettlements.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      turnSettlements.set(key, waiters);
    });
  }

  function shouldCreateTaskNotification(sessionId: string): boolean {
    const window = getMainWindow();
    const liveWindow = window !== null && !window.isDestroyed();
    return shouldCreateTaskNotificationPolicy({
      finishingSessionId: sessionId,
      viewingSessionId: getViewingSessionId(),
      windowVisible: liveWindow && window?.isVisible() === true,
      windowFocused: liveWindow && window?.isFocused() === true,
    });
  }

  return {
    sessionOperationTails,
    turnSettlements,
    activeTurnUsages,
    acquireSessionOperation,
    addActiveTurnUsage,
    activeToolCallKey,
    planSubmissionTurnKey,
    waitForTurnSettlement,
    shouldCreateTaskNotification,
  };
}
