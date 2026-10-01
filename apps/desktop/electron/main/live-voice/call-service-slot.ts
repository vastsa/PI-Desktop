import { randomUUID } from "node:crypto";
import type { LivePrepareRequest } from "@pi-desktop/shared";
import { LiveWorkFeedbackScheduler } from "@pi-desktop/host-runtime";
import type { LiveOwner, Slot } from "./call-service-internals";

export function createLiveCallSlot(owner: LiveOwner, request: LivePrepareRequest, now: () => number): Slot {
  const callId = randomUUID();
  let resolveMediaReleased: (() => void) | null = null;
  const mediaReleased = new Promise<void>((resolve) => { resolveMediaReleased = resolve; });
  return {
    callId,
    requestId: request.requestId,
    requestedBindingId: request.bindingId,
    owner: { ...owner },
    binding: null,
    settingsRevision: request.expectedSettingsRevision,
    phase: "preparing",
    revision: 0,
    abort: new AbortController(),
    desiredMuted: request.initialMuted,
    muted: true,
    captureEpoch: 0,
    playbackEpoch: 0,
    microphoneActive: false,
    mediaRelease: "confirmed",
    mediaReleased,
    resolveMediaReleased,
    userSpeaking: false,
    assistantSpeaking: false,
    assistantPlaybackActive: false,
    playbackMonitorReady: false,
    adapter: null,
    bridge: null,
    releaseMicrophone: null,
    releaseBackgroundLease: null,
    heartbeatAt: now(),
    delegationInstructions: new Map(),
    workBindingRevision: 1,
    workContextConsent: request.shareSelectedSessionContext ?? false,
    workScopeOpened: false,
    workOperations: [],
    workFeedbackScheduler: new LiveWorkFeedbackScheduler({ callId, workBindingRevision: 1 }, now),
    workFeedbackTargets: new Map(),
    workFeedbackStatuses: new Map(),
    workFeedbackTerminalOperations: new Map(),
    workFeedbackTerminalStatuses: new Map(),
    pendingControls: new Map(),
    transcriptLengths: new Map(),
  };
}
