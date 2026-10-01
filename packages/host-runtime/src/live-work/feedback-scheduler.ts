import { randomUUID } from "node:crypto";
import type { LiveWorkFeedback } from "@pi-desktop/shared";

export const LIVE_WORK_FEEDBACK_IDLE_DEBOUNCE_MS = 700;
export const LIVE_WORK_FEEDBACK_MIN_SPEECH_GAP_MS = 3_000;
export const LIVE_WORK_FEEDBACK_STALE_AFTER_MS = 15_000;
export const LIVE_WORK_FEEDBACK_MAX_QUEUE = 8;

export type LiveWorkFeedbackDraft = Omit<LiveWorkFeedback, "feedbackId" | "callId" | "workBindingRevision"> & {
  delegationId?: string;
  dedupeKey?: string;
  speakWhenSilent?: boolean;
};

export type ScheduledLiveWorkFeedback = {
  feedback: LiveWorkFeedback;
  operationIds: string[];
  delegationId?: string;
  speakWhenSilent: boolean;
  enqueuedAt: number;
};

/** Schedules provider feedback without coupling task execution to speech delivery. */
export class LiveWorkFeedbackScheduler {
  private readonly queue: ScheduledLiveWorkFeedback[] = [];
  private readonly seen = new Set<string>();
  private quietSince: number | null = null;
  private lastSpokenAt = Number.NEGATIVE_INFINITY;
  private policy: "normal" | "silent" = "normal";

  constructor(
    private scope: { callId: string; workBindingRevision: number },
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  bindRevision(workBindingRevision: number): void {
    if (!Number.isSafeInteger(workBindingRevision) || workBindingRevision < 1 || this.queue.length > 0) {
      throw new Error("Live work feedback scope cannot be changed");
    }
    this.scope = { ...this.scope, workBindingRevision };
  }

  setPolicy(policy: "normal" | "silent"): void {
    this.policy = policy;
  }

  enqueue(draft: LiveWorkFeedbackDraft): boolean {
    const operationId = draft.operationId;
    const dedupeKey = draft.dedupeKey ?? `${operationId ?? ""}:${draft.kind}:${draft.content}`;
    if (this.seen.has(dedupeKey)) return false;
    this.seen.add(dedupeKey);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value as string);

    const now = this.now();
    const feedback: LiveWorkFeedback = {
      feedbackId: this.createId(),
      ...this.scope,
      ...(operationId ? { operationId } : {}),
      kind: draft.kind,
      delivery: draft.delivery,
      content: boundedText(draft.content, 1_200),
    };
    const queued: ScheduledLiveWorkFeedback = {
      feedback,
      operationIds: operationId ? [operationId] : [],
      ...(draft.delegationId ? { delegationId: draft.delegationId } : {}),
      speakWhenSilent: draft.speakWhenSilent ?? false,
      enqueuedAt: now,
    };
    if (this.queue.length < LIVE_WORK_FEEDBACK_MAX_QUEUE) {
      this.queue.push(queued);
    } else {
      const operationIds = [...new Set([...this.queue.flatMap((item) => item.operationIds), ...queued.operationIds])].slice(-64);
      const first = this.queue[0]!;
      this.queue.splice(0, this.queue.length, {
        feedback: {
          ...first.feedback,
          feedbackId: this.createId(),
          ...(operationIds[0] ? { operationId: operationIds[0] } : {}),
          kind: "status",
          delivery: "speak-when-idle",
          content: "Several work updates are available in the Live panel. Ask for a status or result when you are ready.",
        },
        operationIds,
        ...(first.delegationId ? { delegationId: first.delegationId } : {}),
        speakWhenSilent: first.speakWhenSilent || queued.speakWhenSilent,
        enqueuedAt: now,
      });
    }
    return true;
  }

  noteActivity(): void {
    this.quietSince = null;
  }

  noteDispatched(at = this.now(), delivery: LiveWorkFeedback["delivery"]): void {
    this.quietSince = at;
    if (delivery === "speak-when-idle") this.lastSpokenAt = at;
  }

  nextDelay(now: number, idle: boolean): number | null {
    const next = this.queue[0];
    if (!next) {
      this.quietSince = null;
      return null;
    }
    if (!idle) {
      this.quietSince = null;
      return null;
    }
    this.quietSince ??= now;
    const quietDelay = Math.max(0, LIVE_WORK_FEEDBACK_IDLE_DEBOUNCE_MS - (now - this.quietSince));
    if (quietDelay > 0) return quietDelay;
    const speechEnabled = next.feedback.delivery === "speak-when-idle" &&
      (this.policy === "normal" || next.speakWhenSilent) && now - next.enqueuedAt <= LIVE_WORK_FEEDBACK_STALE_AFTER_MS;
    if (!speechEnabled) return 0;
    const speechDelay = Math.max(0, LIVE_WORK_FEEDBACK_MIN_SPEECH_GAP_MS - (now - this.lastSpokenAt));
    const staleDelay = Math.max(0, LIVE_WORK_FEEDBACK_STALE_AFTER_MS - (now - next.enqueuedAt));
    return Math.min(speechDelay, staleDelay);
  }

  takeReady(now: number, idle: boolean): ScheduledLiveWorkFeedback | undefined {
    if (this.nextDelay(now, idle) !== 0) return undefined;
    const next = this.queue.shift();
    if (!next) return undefined;
    const speak = next.feedback.delivery === "speak-when-idle" &&
      (this.policy === "normal" || next.speakWhenSilent) && now - next.enqueuedAt <= LIVE_WORK_FEEDBACK_STALE_AFTER_MS;
    return {
      ...next,
      feedback: { ...next.feedback, delivery: speak ? "speak-when-idle" : "context-only" },
    };
  }

  get size(): number {
    return this.queue.length;
  }
}

function boundedText(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}
