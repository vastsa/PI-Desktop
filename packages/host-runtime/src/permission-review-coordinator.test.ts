import { describe, expect, it, vi } from "vitest";
import { PermissionReviewCoordinator, type ReviewHost, type ReviewWork } from "./permission-review-coordinator.js";

const work = (requestId: string, sessionId: string): ReviewWork => ({
  requestId, sessionId, requestedAt: 100,
});
const action = { userRequest: "Read the note", toolName: "Read", arguments: { path: "note" }, workspace: "w", permissionMode: "ask" as const, isolation: "none", complete: true };
const approved = { decision: "allow_once" as const, risk: "low" as const, authorization: "explicit" as const, reason: "Requested", policyVersion: "1" };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("PermissionReviewCoordinator", () => {
  it("serializes a session, bounds global concurrency, and settles once", async () => {
    const waiting = new Map<string, (value: typeof approved) => void>();
    const host: ReviewHost = { claim: vi.fn(async (id) => ({ token: "token", fingerprint: "fp", action: { ...action, workspace: id } })), settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}) };
    const reviewer = vi.fn((reviewAction: typeof action) => new Promise<typeof approved>((resolve) => waiting.set(reviewAction.workspace, resolve)));
    const coordinator = new PermissionReviewCoordinator(host, reviewer, () => 101);
    coordinator.enqueue(work("one", "session-a"));
    coordinator.enqueue(work("two", "session-a"));
    coordinator.enqueue(work("three", "session-b"));
    coordinator.enqueue(work("four", "session-c"));
    await flush();
    expect(reviewer).toHaveBeenCalledTimes(2);
    waiting.get("one")?.(approved);
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(3));
    waiting.get("two")?.(approved);
    waiting.get("three")?.(approved);
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(4));
    waiting.get("four")?.(approved);
    await vi.waitFor(() => expect(host.settle).toHaveBeenCalledTimes(4));
  });

  it("does not settle late review after takeover or original deadline", async () => {
    const host: ReviewHost = { claim: vi.fn(async () => ({ token: "token", fingerprint: "fp", action })), settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}) };
    let finish: ((result: typeof approved) => void) | undefined;
    const review = () => new Promise<typeof approved>((resolve) => { finish = resolve; });
    let now = 101;
    const coordinator = new PermissionReviewCoordinator(host, review, () => now);
    coordinator.enqueue(work("one", "s"));
    await flush();
    coordinator.cancel("one");
    finish?.(approved);
    await flush();
    coordinator.enqueue(work("two", "s"));
    await flush();
    now = 120_100;
    finish?.(approved);
    await flush();
    expect(host.settle).not.toHaveBeenCalled();
    expect(host.fallback).not.toHaveBeenCalled();
  });

  it("releases the slot after cancellation even when the reviewer ignores abort", async () => {
    const host: ReviewHost = {
      claim: vi.fn(async () => ({ token: "token", fingerprint: "fp", action })),
      settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}),
    };
    const review = vi.fn().mockImplementationOnce(() => new Promise<typeof approved>(() => {}))
      .mockResolvedValue(approved);
    const coordinator = new PermissionReviewCoordinator(host, review, () => 101);
    coordinator.enqueue(work("one", "s"));
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    coordinator.cancel("one");
    coordinator.enqueue(work("two", "s"));
    await vi.waitFor(() => expect(host.settle).toHaveBeenCalledTimes(1));
    expect(host.fallback).not.toHaveBeenCalled();
  });

  it("hands an unresponsive reviewer back to the user without a second review", async () => {
    vi.useFakeTimers();
    try {
      const host: ReviewHost = {
        claim: vi.fn(async () => ({ token: "token", fingerprint: "fp", action })),
        settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}),
      };
      const review = vi.fn(() => new Promise<typeof approved>(() => {}));
      const coordinator = new PermissionReviewCoordinator(host, review, () => 101);
      coordinator.enqueue(work("one", "s"));
      await flush();
      expect(review).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(host.fallback).toHaveBeenCalledWith("one", "token", "fp", expect.objectContaining({ decision: "needs_user" }));
      expect(host.settle).not.toHaveBeenCalled();
      expect(review).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels queued and active reviews for a stopped session without settling either", async () => {
    const host: ReviewHost = {
      claim: vi.fn(async () => ({ token: "token", fingerprint: "fp", action })),
      settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}),
    };
    const signals: AbortSignal[] = [];
    const review = vi.fn((_action, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<typeof approved>(() => {});
    });
    const coordinator = new PermissionReviewCoordinator(host, review, () => 101);
    coordinator.enqueue({ ...work("one", "stopped"), toolCallId: "tool-one" });
    coordinator.enqueue({ ...work("two", "stopped"), toolCallId: "tool-two" });
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    coordinator.cancelForSession("stopped");
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(host.settle).not.toHaveBeenCalled();
    expect(host.fallback).not.toHaveBeenCalled();
  });

  it("never starts model work when the permission is canceled while claiming", async () => {
    let finishClaim!: (value: Awaited<ReturnType<ReviewHost["claim"]>>) => void;
    const host: ReviewHost = {
      claim: vi.fn(() => new Promise((resolve) => { finishClaim = resolve; })),
      settle: vi.fn(async () => {}), fallback: vi.fn(async () => {}),
    };
    const review = vi.fn(async () => approved);
    const coordinator = new PermissionReviewCoordinator(host, review, () => 101);
    coordinator.enqueue(work("one", "s"));
    coordinator.cancelForSession("s");
    finishClaim({ token: "token", fingerprint: "fp", action });
    await flush();
    expect(review).not.toHaveBeenCalled();
    expect(host.settle).not.toHaveBeenCalled();
  });
});
