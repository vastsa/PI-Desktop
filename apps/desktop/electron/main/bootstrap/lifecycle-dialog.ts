import { randomUUID } from "node:crypto";
import type {
  LifecycleDialogChoice,
  LifecycleDialogKind,
  LifecycleDialogRequest,
} from "@pi-desktop/shared";

export const LIFECYCLE_DIALOG_TIMEOUT_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type LifecycleDialogRequestOptions = {
  windowId: number;
  kind: LifecycleDialogKind;
  send: (request: LifecycleDialogRequest) => void;
  dismiss: (requestId: string) => void;
  fallback: () => Promise<LifecycleDialogChoice>;
};

type PendingRequest = {
  requestId: string;
  windowId: number;
  kind: LifecycleDialogKind;
  dismiss: LifecycleDialogRequestOptions["dismiss"];
  fallback: LifecycleDialogRequestOptions["fallback"];
  resolve: (choice: LifecycleDialogChoice) => void;
  timer: TimerHandle | null;
  active: boolean;
};

type LifecycleDialogBrokerOptions = {
  timeoutMs?: number;
  createRequestId?: () => string;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelSchedule?: (timer: TimerHandle) => void;
};

function isChoiceForKind(
  kind: LifecycleDialogKind,
  choice: unknown,
): choice is LifecycleDialogChoice {
  if (kind === "quit-confirmation") {
    return choice === "cancel" || choice === "confirm";
  }
  return choice === "cancel" || choice === "tray" || choice === "quit";
}

function failOpenChoice(kind: LifecycleDialogKind): LifecycleDialogChoice {
  return kind === "quit-confirmation" ? "confirm" : "quit";
}

/** Routes lifecycle decisions to the ready main renderer, with a bounded native fallback. */
export function createLifecycleDialogBroker({
  timeoutMs = LIFECYCLE_DIALOG_TIMEOUT_MS,
  createRequestId = randomUUID,
  onError,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}: LifecycleDialogBrokerOptions = {}) {
  let readyWindowId: number | null = null;
  const pending = new Map<string, PendingRequest>();

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A logging failure must not keep the app from exiting.
    }
  };

  const fallbackChoice = async (
    kind: LifecycleDialogKind,
    fallback: LifecycleDialogRequestOptions["fallback"],
  ): Promise<LifecycleDialogChoice> => {
    try {
      const choice = await fallback();
      if (isChoiceForKind(kind, choice)) return choice;
      report(new Error("lifecycle dialog fallback returned an invalid choice"));
    } catch (error) {
      report(error);
    }
    return failOpenChoice(kind);
  };

  const settle = (request: PendingRequest, choice: LifecycleDialogChoice) => {
    if (!request.active) return;
    request.active = false;
    pending.delete(request.requestId);
    if (request.timer !== null) cancelSchedule(request.timer);
    request.resolve(choice);
  };

  const useFallback = (request: PendingRequest) => {
    if (!request.active) return;
    request.active = false;
    pending.delete(request.requestId);
    if (request.timer !== null) cancelSchedule(request.timer);
    try {
      request.dismiss(request.requestId);
    } catch (error) {
      report(error);
    }
    void fallbackChoice(request.kind, request.fallback).then(request.resolve);
  };

  return {
    markReady(windowId: number): void {
      readyWindowId = windowId;
    },

    markUnavailable(windowId: number): void {
      if (readyWindowId === windowId) readyWindowId = null;
      for (const request of pending.values()) {
        if (request.windowId === windowId) useFallback(request);
      }
    },

    respond(
      senderWindowId: number,
      requestId: unknown,
      choice: unknown,
    ): boolean {
      if (typeof requestId !== "string" || !requestId) return false;
      const request = pending.get(requestId);
      if (
        !request ||
        request.windowId !== senderWindowId ||
        !isChoiceForKind(request.kind, choice)
      ) {
        return false;
      }
      settle(request, choice);
      return true;
    },

    request({ windowId, kind, send, dismiss, fallback }: LifecycleDialogRequestOptions) {
      if (readyWindowId !== windowId || pending.size > 0) {
        return fallbackChoice(kind, fallback);
      }

      return new Promise<LifecycleDialogChoice>((resolve) => {
        const requestId = createRequestId();
        const current: PendingRequest = {
          requestId,
          windowId,
          kind,
          dismiss,
          fallback,
          resolve,
          timer: null,
          active: true,
        };
        pending.set(requestId, current);

        try {
          current.timer = schedule(() => useFallback(current), timeoutMs);
          send({ requestId, kind });
        } catch {
          useFallback(current);
        }
      });
    },
  };
}
