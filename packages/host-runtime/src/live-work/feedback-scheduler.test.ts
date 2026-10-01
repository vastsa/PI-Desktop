import { describe, expect, it } from "vitest";
import { LiveWorkFeedbackScheduler, LIVE_WORK_FEEDBACK_MAX_QUEUE } from "./feedback-scheduler.js";

describe("LiveWorkFeedbackScheduler", () => {
  it("waits for provider, playback, and user idle plus the debounce before dispatch", () => {
    let now = 100;
    const scheduler = new LiveWorkFeedbackScheduler({ callId: "call-a", workBindingRevision: 4 }, () => now, () => "feedback-1");
    scheduler.enqueue({ operationId: "op-1", kind: "result", delivery: "speak-when-idle", content: "Task completed." });
    expect(scheduler.nextDelay(now, false)).toBeNull();
    expect(scheduler.nextDelay(now, true)).toBe(700);
    now += 699;
    expect(scheduler.takeReady(now, true)).toBeUndefined();
    now += 1;
    expect(scheduler.takeReady(now, true)).toMatchObject({
      feedback: { callId: "call-a", workBindingRevision: 4, operationId: "op-1", delivery: "speak-when-idle" },
    });
  });

  it("keeps speech quiet in silent mode and downgrades stale speech to context only", () => {
    let now = 0;
    const scheduler = new LiveWorkFeedbackScheduler({ callId: "call-a", workBindingRevision: 1 }, () => now, () => `feedback-${now}`);
    scheduler.setPolicy("silent");
    scheduler.enqueue({ operationId: "op-silent", kind: "result", delivery: "speak-when-idle", content: "Task completed." });
    expect(scheduler.nextDelay(now, true)).toBe(700);
    now = 700;
    expect(scheduler.takeReady(now, true)?.feedback.delivery).toBe("context-only");

    scheduler.setPolicy("normal");
    scheduler.enqueue({ operationId: "op-stale", kind: "result", delivery: "speak-when-idle", content: "Another task completed." });
    scheduler.noteDispatched(now, "context-only");
    now = 15_701;
    expect(scheduler.takeReady(now, true)?.feedback.delivery).toBe("context-only");
  });

  it("still speaks an explicit status query while automatic announcements are silent", () => {
    let now = 0;
    const scheduler = new LiveWorkFeedbackScheduler({ callId: "call-a", workBindingRevision: 1 }, () => now, () => "query-feedback");
    scheduler.setPolicy("silent");
    scheduler.enqueue({
      operationId: "op-query",
      kind: "result",
      delivery: "speak-when-idle",
      content: "The last task completed.",
      speakWhenSilent: true,
    });
    expect(scheduler.nextDelay(now, true)).toBe(700);
    now = 700;
    expect(scheduler.takeReady(now, true)?.feedback.delivery).toBe("speak-when-idle");
  });

  it("enforces the speech gap, deduplicates result versions, and coalesces overflow", () => {
    let now = 0;
    let id = 0;
    const scheduler = new LiveWorkFeedbackScheduler({ callId: "call-a", workBindingRevision: 2 }, () => now, () => `feedback-${++id}`);
    scheduler.enqueue({ operationId: "op-0", kind: "result", delivery: "speak-when-idle", content: "Result 0" });
    expect(scheduler.enqueue({ operationId: "op-0", kind: "result", delivery: "speak-when-idle", content: "Result 0" })).toBe(false);
    for (let index = 1; index <= LIVE_WORK_FEEDBACK_MAX_QUEUE; index += 1) {
      scheduler.enqueue({ operationId: `op-${index}`, kind: "result", delivery: "speak-when-idle", content: `Result ${index}` });
    }
    expect(scheduler.size).toBe(1);
    expect(scheduler.nextDelay(now, true)).toBe(700);
    now = 700;
    const combined = scheduler.takeReady(now, true)!;
    expect(combined.operationIds).toHaveLength(LIVE_WORK_FEEDBACK_MAX_QUEUE + 1);
    expect(combined.feedback.content).toContain("Several work updates");
    scheduler.enqueue({ operationId: "op-next", kind: "result", delivery: "speak-when-idle", content: "Next result" });
    scheduler.noteDispatched(now, "speak-when-idle");
    now += 700;
    expect(scheduler.nextDelay(now, true)).toBe(2_300);
  });

  it("keeps a shared turn result to one automatic feedback item", () => {
    const scheduler = new LiveWorkFeedbackScheduler({ callId: "call-a", workBindingRevision: 2 }, () => 0, () => "feedback-id");
    expect(scheduler.enqueue({
      operationId: "op-1",
      dedupeKey: "terminal:turn-1:completed",
      kind: "result",
      delivery: "speak-when-idle",
      content: "Task completed.",
    })).toBe(true);
    expect(scheduler.enqueue({
      operationId: "op-2",
      dedupeKey: "terminal:turn-1:completed",
      kind: "result",
      delivery: "speak-when-idle",
      content: "Task completed.",
    })).toBe(false);
    expect(scheduler.size).toBe(1);
  });
});
