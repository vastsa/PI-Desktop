import type { PermissionReviewResult, ReviewAction } from "@pi-desktop/agent-runtime";
export type { PermissionReviewResult, ReviewAction } from "@pi-desktop/agent-runtime";

export type ReviewWork = {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  /** Timestamp of the original host permission request, never reset on fallback. */
  requestedAt: number;
};

export type ReviewHost = {
  /** Claim binds the current permission's fingerprint and returns a one-use review token. */
  claim(requestId: string): Promise<{ token: string; fingerprint: string; action: ReviewAction }>;
  settle(requestId: string, token: string, fingerprint: string, result: PermissionReviewResult): Promise<void>;
  fallback(requestId: string, token: string, fingerprint: string, result: PermissionReviewResult): Promise<void>;
};

export type ReviewExecutor = (action: ReviewAction, signal: AbortSignal, sessionId: string) => Promise<PermissionReviewResult>;

type QueuedReview = ReviewWork & { controller: AbortController };

/** Host-owned request lifecycle: two concurrent reviews globally, one per session. */
export class PermissionReviewCoordinator {
  private readonly queue: QueuedReview[] = [];
  private readonly current = new Map<string, QueuedReview>();
  private readonly sessions = new Set<string>();
  private stopped = false;

  constructor(
    private readonly host: ReviewHost,
    private readonly review: ReviewExecutor,
    private readonly now: () => number = Date.now,
    private readonly report?: (code: "claim_failed" | "review_failed" | "settle_failed") => void,
  ) {}

  enqueue(work: ReviewWork): void {
    if (this.stopped || this.current.has(work.requestId) || this.queue.some((item) => item.requestId === work.requestId)) return;
    this.queue.push({ ...work, controller: new AbortController() });
    this.startAvailable();
  }

  cancel(requestId: string): void {
    const queued = this.queue.findIndex((item) => item.requestId === requestId);
    if (queued >= 0) this.queue.splice(queued, 1)[0]?.controller.abort();
    const active = this.current.get(requestId);
    if (active) active.controller.abort();
  }

  cancelForTool(sessionId: string, toolCallId: string): void {
    for (const item of [...this.queue, ...this.current.values()]) {
      if (item.sessionId === sessionId && item.toolCallId === toolCallId) this.cancel(item.requestId);
    }
  }

  cancelForSession(sessionId: string): void {
    for (const item of [...this.queue, ...this.current.values()]) {
      if (item.sessionId === sessionId) this.cancel(item.requestId);
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const item of this.queue) item.controller.abort();
    this.queue.length = 0;
    for (const item of this.current.values()) item.controller.abort();
  }

  private startAvailable(): void {
    if (this.stopped) return;
    while (this.current.size < 2) {
      const index = this.queue.findIndex((item) => !this.sessions.has(item.sessionId));
      if (index < 0) break;
      const item = this.queue.splice(index, 1)[0]!;
      this.current.set(item.requestId, item);
      this.sessions.add(item.sessionId);
      void this.run(item).catch(() => this.report?.("review_failed")).finally(() => {
        this.current.delete(item.requestId);
        this.sessions.delete(item.sessionId);
        this.startAvailable();
      });
    }
  }

  private async run(item: QueuedReview): Promise<void> {
    if (item.controller.signal.aborted) return;
    let claimed: { token: string; fingerprint: string; action: ReviewAction };
    try {
      claimed = await this.host.claim(item.requestId);
    } catch {
      this.report?.("claim_failed");
      return; // The host owns a canceled/expired request and its manual state.
    }
    if (item.controller.signal.aborted) return;
    const expiresAt = item.requestedAt + 120_000;
    let result: PermissionReviewResult;
    let timedOut = false;
    try {
      if (this.now() >= expiresAt) throw new Error("Permission expired");
      result = await new Promise<PermissionReviewResult>((resolve, reject) => {
        let settled = false;
        const settle = (done: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          item.controller.signal.removeEventListener("abort", onAbort);
          done();
        };
        const onAbort = () => settle(() => reject(new Error("Reviewer canceled")));
        const timeout = setTimeout(() => {
          timedOut = true;
          item.controller.abort();
        }, Math.min(20_000, expiresAt - this.now()));
        item.controller.signal.addEventListener("abort", onAbort, { once: true });
        if (item.controller.signal.aborted) onAbort();
        void Promise.resolve().then(() => {
          item.controller.signal.throwIfAborted();
          return this.review(claimed.action, item.controller.signal, item.sessionId);
        })
          .then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
      });
    } catch {
      this.report?.("review_failed");
      result = { decision: "needs_user", risk: "high", authorization: "uncertain", reason: "Automated review is unavailable.", policyVersion: "1" };
    }
    if (this.stopped || this.now() >= expiresAt) return;
    if (item.controller.signal.aborted && !timedOut) return;
    try {
      if (result.decision === "needs_user") {
        await this.host.fallback(item.requestId, claimed.token, claimed.fingerprint, result);
      } else {
        await this.host.settle(item.requestId, claimed.token, claimed.fingerprint, result);
      }
    } catch {
      this.report?.("settle_failed");
      // Stale, revoked, and concurrently settled decisions are rejected by the host.
    }
  }
}
