import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { LiveDelegationRequest, LiveProviderReceipt, LiveWorkFeedback, LiveWorkOperationView } from "@pi-desktop/shared";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  MAX_DELEGATIONS_PER_CALL,
  MAX_INSTRUCTION_BYTES,
  REJECTION_ACK_TIMEOUT_MS,
  liveError,
  type LiveCallServiceDeps,
  type LiveOwner,
  type Slot,
} from "./call-service-internals";

type Dependencies = Pick<LiveCallServiceDeps, "ownerAlive" | "sendControl" | "receiveWorkCandidate"> & {
  current: () => Slot | null;
  publish: (slot: Slot) => void;
  fail: (slot: Slot, error: Error, stage: "control") => Promise<void>;
};

export function createLiveCallWorkHandlers(deps: Dependencies) {
  return {
    async reportDelegation(slot: Slot, owner: LiveOwner, request: LiveDelegationRequest): Promise<{ accepted: boolean }> {
      if (slot.binding?.adapterId !== "codex-live" || typeof request.delegationId !== "string" || !request.delegationId.trim() || request.delegationId.length > 256 || typeof request.instruction !== "string" || Buffer.byteLength(request.instruction, "utf8") > MAX_INSTRUCTION_BYTES) {
        throw liveError("LIVE_PROTOCOL_ERROR");
      }
      const id = request.delegationId.trim();
      const prior = slot.delegationInstructions.get(id);
      if (prior !== undefined) {
        if (prior !== request.instruction) throw liveError("LIVE_PROTOCOL_ERROR");
      } else {
        if (slot.delegationInstructions.size >= MAX_DELEGATIONS_PER_CALL) throw liveError("LIVE_PROTOCOL_ERROR");
        slot.delegationInstructions.set(id, request.instruction);
      }
      if (slot.workScopeOpened && deps.receiveWorkCandidate) {
        void deps.receiveWorkCandidate(
          {
            callId: slot.callId,
            workBindingRevision: slot.workBindingRevision,
            workSessionId: slot.workBinding?.workSessionId ?? `live-work-unselected:${slot.callId}`,
            providerRequestId: id,
            instruction: request.instruction,
          },
          (receipt) => deliverReceipt(slot, id, receipt, deps),
        ).catch(() => undefined);
        return { accepted: true };
      }
      if (prior !== undefined) return { accepted: true };
      const actionId = randomUUID();
      const timer = setTimeout(() => {
        const current = deps.current();
        if (current !== slot || !slot.pendingControls.has(actionId)) return;
        slot.pendingControls.delete(actionId);
        slot.notice = { code: "LIVE_EXECUTION_NOT_CONNECTED", retriable: false };
        void deps.fail(slot, liveError("LIVE_PROTOCOL_ERROR"), "control");
      }, REJECTION_ACK_TIMEOUT_MS);
      slot.pendingControls.set(actionId, { timer, kind: "reject" });
      deps.sendControl(owner, { callId: slot.callId, kind: "reject-delegation", actionId, delegationId: id, reason: "EXECUTION_NOT_CONNECTED" });
      deps.publish(slot);
      return { accepted: true };
    },

    reportControlApplied(slot: Slot, input: { actionId: string; applied: boolean; errorCode?: string }): void {
      const pending = slot.pendingControls.get(input.actionId);
      if (!pending) return;
      clearTimeout(pending.timer);
      slot.pendingControls.delete(input.actionId);
      if (pending.kind === "work-receipt") {
        if (input.applied) pending.resolve?.({ status: "sent", deliveryId: input.actionId });
        else pending.resolve?.({
          status: "not-sent",
          deliveryId: input.actionId,
          code: input.errorCode ?? "LIVE_WORK_FEEDBACK_UNDELIVERED",
        });
        return;
      }
      if (pending.kind === "work-navigation") {
        pending.resolve?.(input.applied
          ? { status: "sent", deliveryId: input.actionId }
          : { status: "not-sent", deliveryId: input.actionId, code: input.errorCode ?? "LIVE_WORK_FEEDBACK_UNDELIVERED" });
        return;
      }
      if (pending.kind === "work-feedback") {
        pending.resolve?.(input.applied
          ? { status: "sent", deliveryId: input.actionId }
          : { status: "not-sent", deliveryId: input.actionId, code: input.errorCode ?? "LIVE_WORK_FEEDBACK_UNDELIVERED" });
        return;
      }
      if (!input.applied) {
        slot.notice = { code: ErrorCodes.LIVE_EXECUTION_NOT_CONNECTED, retriable: false };
        deps.publish(slot);
        void deps.fail(slot, liveError("LIVE_PROTOCOL_ERROR"), "control");
      }
    },

    notifyWorkOperation(callId: string, operation: LiveWorkOperationView): void {
      const slot = deps.current();
      if (!slot || slot.callId !== callId || !slot.workScopeOpened) return;
      const existing = slot.workOperations.findIndex((item) => item.operationId === operation.operationId);
      slot.workOperations = existing < 0
        ? [...slot.workOperations, operation].slice(-8)
        : slot.workOperations.map((item, index) => index === existing ? operation : item);
      deps.publish(slot);
    },

    navigateSession(slot: Slot, sessionId: string): Promise<import("./types").LiveReceiptDelivery> {
      const actionId = randomUUID();
      if (!sessionId.trim() || sessionId.length > 256 || deps.current() !== slot || !deps.ownerAlive(slot.owner)) {
        return Promise.resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_OWNER_UNAVAILABLE" });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const current = deps.current();
          if (current !== slot || !slot.pendingControls.delete(actionId)) return;
          resolve({ status: "unknown", deliveryId: actionId, code: "LIVE_CONTROL_ACK_TIMEOUT" });
        }, REJECTION_ACK_TIMEOUT_MS);
        slot.pendingControls.set(actionId, { timer, kind: "work-navigation", resolve });
        try {
          deps.sendControl(slot.owner, { callId: slot.callId, kind: "work-navigation", actionId, sessionId });
        } catch {
          clearTimeout(timer);
          slot.pendingControls.delete(actionId);
          resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
        }
      });
    },

    sendWorkFeedback(slot: Slot, delegationId: string, feedback: LiveWorkFeedback): Promise<import("./types").LiveReceiptDelivery> {
      const actionId = randomUUID();
      if (
        !delegationId.trim() || delegationId.length > 256 || !slot.workScopeOpened ||
        feedback.callId !== slot.callId || feedback.workBindingRevision !== slot.workBindingRevision ||
        Buffer.byteLength(feedback.content, "utf8") === 0 || Buffer.byteLength(feedback.content, "utf8") > 1_200 ||
        deps.current() !== slot || !deps.ownerAlive(slot.owner)
      ) {
        return Promise.resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const current = deps.current();
          if (current !== slot || !slot.pendingControls.delete(actionId)) return;
          resolve({ status: "unknown", deliveryId: actionId, code: "LIVE_CONTROL_ACK_TIMEOUT" });
        }, REJECTION_ACK_TIMEOUT_MS);
        slot.pendingControls.set(actionId, { timer, kind: "work-feedback", resolve });
        try {
          deps.sendControl(slot.owner, { callId: slot.callId, kind: "work-feedback", actionId, delegationId, feedback });
        } catch {
          clearTimeout(timer);
          slot.pendingControls.delete(actionId);
          resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
        }
      });
    },
  };
}

function deliverReceipt(
  slot: Slot,
  delegationId: string,
  receipt: LiveProviderReceipt,
  deps: Dependencies,
): Promise<import("./types").LiveReceiptDelivery> {
  const actionId = randomUUID();
  if (deps.current() !== slot || !deps.ownerAlive(slot.owner)) {
    return Promise.resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_OWNER_UNAVAILABLE" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const current = deps.current();
      if (current !== slot || !slot.pendingControls.delete(actionId)) return;
      resolve({ status: "unknown", deliveryId: actionId, code: "LIVE_CONTROL_ACK_TIMEOUT" });
    }, REJECTION_ACK_TIMEOUT_MS);
    slot.pendingControls.set(actionId, { timer, kind: "work-receipt", resolve });
    try {
      deps.sendControl(slot.owner, {
        callId: slot.callId,
        kind: "work-receipt",
        actionId,
        delegationId,
        receipt,
      });
    } catch {
      clearTimeout(timer);
      slot.pendingControls.delete(actionId);
      resolve({ status: "not-sent", deliveryId: actionId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
    }
  });
}
