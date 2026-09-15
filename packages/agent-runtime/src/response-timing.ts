import type { UiMessage } from "@pi-desktop/shared";

/** One logical model request, including its transport retries, measured before IPC. */
export class FirstOutputTiming {
  private startedAt?: number;
  private firstOutputMs?: number;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  start(): number {
    this.startedAt = this.clock();
    this.firstOutputMs = undefined;
    return Date.now();
  }

  observe(message: UiMessage, hasNewOutput: boolean): UiMessage {
    if (this.startedAt === undefined) return message;
    if (this.firstOutputMs === undefined && hasNewOutput) {
      this.firstOutputMs = Math.max(0, Math.round(this.clock() - this.startedAt));
    }
    return { ...message, timeToFirstTokenMs: this.firstOutputMs };
  }
}

/** Preserve the existing diagnostic anchors; these are distinct from TTFT. */
export function completedResponseTiming(
  requestStartedAt: number | undefined,
  streamStartedAt: number | undefined,
  endedAt: number,
): { providerWaitMs?: number; streamMs?: number } {
  return {
    providerWaitMs: requestStartedAt !== undefined && streamStartedAt !== undefined
      ? streamStartedAt - requestStartedAt : undefined,
    streamMs: streamStartedAt !== undefined
      ? Math.max(0, endedAt - streamStartedAt) : undefined,
  };
}
