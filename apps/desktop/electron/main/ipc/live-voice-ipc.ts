import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IPC, type LiveEndReason, type LiveVoiceWidgetAction } from "@pi-desktop/shared";
import type { LiveCallService as LiveCallServiceImpl, LiveOwner } from "../live-voice/call-service";
import { liveOwnerFromInvoke } from "../live-voice/owner";
import type { IpcRegistrar } from "./types";
import type { LiveVoiceWidget } from "../live-voice/widget-window";
import type { LiveVoiceWidgetSize } from "../live-voice/widget-geometry";

const END_REASONS = new Set([
  "user-ended", "user-cancelled-start", "window-hidden", "window-navigated", "renderer-gone",
  "app-suspended", "app-quit", "provider-invalidated", "disabled", "timeout", "network-error",
  "protocol-error", "audio-backpressure", "media-release-unconfirmed",
]);

export function registerLiveVoiceIpc(input: {
  registrar: IpcRegistrar;
  service: LiveCallServiceImpl;
  getMainWindow: () => BrowserWindow | null;
  /** The docked widget window: not a call owner, but allowed to drive its chrome. */
  widget: Pick<LiveVoiceWidget, "owns" | "setPresentation" | "requestAction" | "setOwnerState">;
}): void {
  const { registrar, service, getMainWindow, widget } = input;
  const owner = (event: IpcMainInvokeEvent): LiveOwner => {
    registrar.assertMainWindowSender(event);
    return liveOwnerFromInvoke(event, getMainWindow());
  };

  // The widget window is not the call owner: it may only ask the owner frame to
  // run an action and report the box its own content needs.
  const assertWidgetSender = (event: IpcMainInvokeEvent): void => {
    if (!widget.owns(event.sender.id)) {
      throw Object.assign(new Error("renderer is not the Live Voice widget"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  registrar.handleWithEvent(IPC.invoke.liveVoiceStatus, async (event) => {
    owner(event);
    return service.status();
  });
  registrar.handleWithEvent(IPC.invoke.liveVoicePrepare, async (event, raw: unknown) => {
    return service.prepare(owner(event), parsePrepare(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceConnect, async (event, raw: unknown) => {
    return service.connect(owner(event), parseConnect(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceSetMuted, async (event, raw: unknown) => {
    return service.setMuted(owner(event), parseMute(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceReportMedia, async (event, raw: unknown) => {
    return service.reportMedia(owner(event), parseMedia(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceReportPlayback, async (event, raw: unknown) => {
    service.reportPlayback(owner(event), parsePlayback(raw));
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceReportDelegation, async (event, raw: unknown) => {
    return service.reportDelegation(owner(event), parseDelegation(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceReportControlApplied, async (event, raw: unknown) => {
    service.reportControlApplied(owner(event), parseControlApplied(raw));
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceEnd, async (event, raw: unknown) => {
    return service.end(owner(event), parseEnd(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceHeartbeat, async (event, raw: unknown) => {
    const input = record(raw);
    exactKeys(input, ["callId"]);
    return service.heartbeat(owner(event), callId(input.callId));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceResolveWorkSelection, async (event, raw: unknown) => {
    return service.resolveWorkSelection(owner(event), parseResolveWorkSelection(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceStopWorkOperation, async (event, raw: unknown) => {
    return service.stopWorkOperation(owner(event), parseWorkOperationControl(raw));
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceCancelQueuedOperation, async (event, raw: unknown) => {
    return service.cancelQueuedWorkOperation(owner(event), parseWorkOperationControl(raw));
  });
  // The widget's own two channels: it reports the box its content needs and the
  // actions its buttons ask for. Actions run in the owner frame, never here.
  registrar.handleWithEvent(IPC.invoke.liveVoiceWidgetVisibility, async (event, raw: unknown) => {
    assertWidgetSender(event);
    const presentation = parseWidgetPresentation(raw);
    widget.setPresentation(presentation.visible, presentation);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.liveVoiceWidgetAction, async (event, raw: unknown) => {
    assertWidgetSender(event);
    widget.requestAction(parseWidgetAction(raw));
    return { ok: true };
  });
  // What only the owner frame knows about this call: its own failure code (a
  // refused action is local to the frame that ran it) and whether the bound work
  // session is waiting on a decision the user has to make elsewhere. Neither is
  // in the call view, so the widget can only show them if the owner reports them.
  registrar.handleWithEvent(IPC.invoke.liveVoiceWidgetOwnerState, async (event, raw: unknown) => {
    registrar.assertMainWindowSender(event);
    widget.setOwnerState(parseWidgetOwnerState(raw));
    return { ok: true };
  });
}

export function parseWorkOperationControl(raw: unknown): { callId: string; operationId: string } {
  const input = record(raw);
  exactKeys(input, ["callId", "operationId"]);
  if (typeof input.operationId !== "string" || !input.operationId.trim() || input.operationId.length > 256) return invalid();
  return { callId: callId(input.callId), operationId: input.operationId };
}

function parseResolveWorkSelection(raw: unknown): { callId: string; selectionRef: string } {
  const input = record(raw);
  exactKeys(input, ["callId", "selectionRef"]);
  if (typeof input.selectionRef !== "string" || !input.selectionRef.trim() || input.selectionRef.length > 256) return invalid();
  return { callId: callId(input.callId), selectionRef: input.selectionRef };
}

export function parsePrepare(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["requestId", "bindingId", "expectedSettingsRevision", "initialMuted", "workTarget", "shareSelectedSessionContext"]);
  if (typeof input.requestId !== "string" || typeof input.bindingId !== "string" || !input.bindingId.trim() || input.bindingId.length > 256 || !Number.isSafeInteger(input.expectedSettingsRevision) || (input.expectedSettingsRevision as number) < 0 || typeof input.initialMuted !== "boolean") return invalid();
  let workTarget: { workSessionId: string } | undefined;
  if (input.workTarget !== undefined) {
    const target = record(input.workTarget);
    exactKeys(target, ["workSessionId"]);
    if (typeof target.workSessionId !== "string" || !target.workSessionId.trim() || target.workSessionId.length > 256) return invalid();
    workTarget = { workSessionId: target.workSessionId };
  }
  if (input.shareSelectedSessionContext !== undefined && typeof input.shareSelectedSessionContext !== "boolean") return invalid();
  return {
    requestId: input.requestId,
    bindingId: input.bindingId,
    expectedSettingsRevision: input.expectedSettingsRevision as number,
    initialMuted: input.initialMuted,
    ...(workTarget ? { workTarget } : {}),
    ...(input.shareSelectedSessionContext !== undefined ? { shareSelectedSessionContext: input.shareSelectedSessionContext } : {}),
  };
}

function parseConnect(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["callId", "offerSdp"]);
  const result: { callId: string; offerSdp?: string } = { callId: callId(input.callId) };
  if (input.offerSdp !== undefined) {
    if (typeof input.offerSdp !== "string" || Buffer.byteLength(input.offerSdp, "utf8") > 256 * 1024) return invalid();
    result.offerSdp = input.offerSdp;
  }
  return result;
}

function parseMute(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["callId", "muted", "captureEpoch"]);
  if (typeof input.muted !== "boolean" || !Number.isSafeInteger(input.captureEpoch) || (input.captureEpoch as number) < 0) return invalid();
  return { callId: callId(input.callId), muted: input.muted, captureEpoch: input.captureEpoch as number };
}

export function parseMedia(raw: unknown) {
  const input = record(raw);
  const kind = input.kind;
  if (kind === "microphone-active") {
    exactKeys(input, ["callId", "kind", "active"]);
    if (typeof input.active !== "boolean") return invalid();
    return { callId: callId(input.callId), kind, active: input.active } as const;
  }
  if (kind === "phase") {
    exactKeys(input, ["callId", "kind", "phase"]);
    if (input.phase !== "connecting" && input.phase !== "connected") return invalid();
    return { callId: callId(input.callId), kind, phase: input.phase } as const;
  }
  if (kind === "activity") {
    exactKeys(input, ["callId", "kind", "userSpeaking", "assistantSpeaking"]);
    if ((input.userSpeaking !== undefined && typeof input.userSpeaking !== "boolean") || (input.assistantSpeaking !== undefined && typeof input.assistantSpeaking !== "boolean")) return invalid();
    return { callId: callId(input.callId), kind, ...(input.userSpeaking !== undefined ? { userSpeaking: input.userSpeaking } : {}), ...(input.assistantSpeaking !== undefined ? { assistantSpeaking: input.assistantSpeaking } : {}) } as const;
  }
  if (kind === "playback-activity") {
    exactKeys(input, ["callId", "kind", "active", "ready"]);
    if (typeof input.active !== "boolean" || typeof input.ready !== "boolean") return invalid();
    return { callId: callId(input.callId), kind, active: input.active, ready: input.ready } as const;
  }
  if (kind === "playback-blocked") {
    exactKeys(input, ["callId", "kind", "blocked"]);
    if (typeof input.blocked !== "boolean") return invalid();
    return { callId: callId(input.callId), kind, blocked: input.blocked } as const;
  }
  if (kind === "released") {
    exactKeys(input, ["callId", "kind"]);
    return { callId: callId(input.callId), kind } as const;
  }
  return invalid();
}

function parsePlayback(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["callId", "cursors"]);
  if (!Array.isArray(input.cursors) || input.cursors.length > 64) return invalid();
  const cursors = input.cursors.map((rawCursor) => {
    const cursor = record(rawCursor);
    exactKeys(cursor, ["itemId", "contentIndex", "playedSamples", "sampleRate"]);
    if (typeof cursor.itemId !== "string" || !cursor.itemId || cursor.itemId.length > 256 || !Number.isSafeInteger(cursor.contentIndex) || (cursor.contentIndex as number) < 0 || !Number.isSafeInteger(cursor.playedSamples) || (cursor.playedSamples as number) < 0 || (cursor.playedSamples as number) > 24_000 * 60 || cursor.sampleRate !== 24_000) return invalid();
    return { itemId: cursor.itemId, contentIndex: cursor.contentIndex as number, playedSamples: cursor.playedSamples as number, sampleRate: 24_000 as const };
  });
  return { callId: callId(input.callId), cursors };
}

function parseDelegation(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["callId", "delegationId", "instruction"]);
  if (typeof input.delegationId !== "string" || !input.delegationId.trim() || input.delegationId.length > 256 || typeof input.instruction !== "string" || Buffer.byteLength(input.instruction, "utf8") > 8 * 1024) return invalid();
  return { callId: callId(input.callId), delegationId: input.delegationId, instruction: input.instruction };
}

function parseControlApplied(raw: unknown) {
  const input = record(raw);
  exactKeys(input, ["callId", "actionId", "applied", "errorCode"]);
  if (typeof input.actionId !== "string" || !input.actionId || input.actionId.length > 128 || typeof input.applied !== "boolean" || (input.errorCode !== undefined && (typeof input.errorCode !== "string" || input.errorCode.length > 80))) return invalid();
  return { callId: callId(input.callId), actionId: input.actionId, applied: input.applied, ...(typeof input.errorCode === "string" ? { errorCode: input.errorCode } : {}) };
}

function parseEnd(raw: unknown) {
  const input = record(raw);
  if (typeof input.reason !== "string" || !END_REASONS.has(input.reason)) return invalid();
  if (input.callId !== undefined) {
    exactKeys(input, ["callId", "reason"]);
    return { callId: callId(input.callId), reason: input.reason as LiveEndReason };
  }
  exactKeys(input, ["requestId", "reason"]);
  if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 64 || input.reason !== "user-cancelled-start") return invalid();
  return { requestId: input.requestId, reason: input.reason } as const;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function callId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) return invalid();
  return value;
}

function invalid(): never {
  throw Object.assign(new Error("Live Voice request is invalid"), { errorCode: "LIVE_PROTOCOL_ERROR" });
}

const WIDGET_ACTIONS = new Set<LiveVoiceWidgetAction>(["cancel", "mute", "resume", "end", "details", "settings"]);

export function parseWidgetAction(raw: unknown): LiveVoiceWidgetAction {
  const input = record(raw);
  exactKeys(input, ["action"]);
  if (typeof input.action !== "string" || !WIDGET_ACTIONS.has(input.action as LiveVoiceWidgetAction)) return invalid();
  return input.action as LiveVoiceWidgetAction;
}

/**
 * The widget's own measured content box. Sizes outside the bar's own range are
 * clamped by the window layer, so only the shape is validated here.
 */
export function parseWidgetPresentation(raw: unknown): { visible: boolean } & LiveVoiceWidgetSize {
  const input = record(raw);
  exactKeys(input, ["visible", "width", "height"]);
  if (typeof input.visible !== "boolean" || !Number.isFinite(input.width) || !Number.isFinite(input.height)) return invalid();
  return { visible: input.visible, width: input.width as number, height: input.height as number };
}

/** The owner frame's own view of the call: its failure code and pending decision. */
export function parseWidgetOwnerState(raw: unknown): { callId: string; errorCode: string | null; decisionWaiting: boolean } {
  const input = record(raw);
  exactKeys(input, ["callId", "errorCode", "decisionWaiting"]);
  if (input.errorCode !== null && (typeof input.errorCode !== "string" || !input.errorCode || input.errorCode.length > 80)) return invalid();
  if (typeof input.decisionWaiting !== "boolean") return invalid();
  return { callId: callId(input.callId), errorCode: input.errorCode as string | null, decisionWaiting: input.decisionWaiting };
}
