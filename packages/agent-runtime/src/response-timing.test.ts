import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { FirstOutputTiming, completedResponseTiming } from "./response-timing.js";

const message: UiMessage = { id: "a", role: "assistant", content: "", createdAt: "2026-09-15" };

describe("first model output timing", () => {
  it("ignores lifecycle events and locks on the first thinking output", () => {
    let now = 100;
    const timing = new FirstOutputTiming(() => now);
    timing.start();
    now = 600;
    expect(timing.observe(message, false).timeToFirstTokenMs).toBeUndefined();
    now = 1350;
    const thinking = timing.observe({ ...message, thinking: "plan" }, true);
    expect(thinking.timeToFirstTokenMs).toBe(1250);
    now = 9000;
    expect(timing.observe({ ...thinking, content: "answer" }, true).timeToFirstTokenMs).toBe(1250);
  });

  it("resets for the next request and does not count retained retry content", () => {
    let now = 0;
    const timing = new FirstOutputTiming(() => now);
    timing.start();
    now = 400;
    const previous = timing.observe({ ...message, content: "old" }, true);
    now = 20000;
    timing.start();
    expect(timing.observe(previous, false).timeToFirstTokenMs).toBeUndefined();
    now = 20700;
    expect(timing.observe({ ...message, content: "new" }, true).timeToFirstTokenMs).toBe(700);
  });

  it("allows zero, omits unknown latency, and never invents latency for tool-only output", () => {
    const timing = new FirstOutputTiming(() => 100);
    expect(timing.observe(message, true).timeToFirstTokenMs).toBeUndefined();
    timing.start();
    expect(timing.observe(message, false).timeToFirstTokenMs).toBeUndefined();
    expect(timing.observe({ ...message, content: "instant" }, true).timeToFirstTokenMs).toBe(0);
  });

  it("preserves existing diagnostic stream timing", () => {
    expect(completedResponseTiming(100, 300, 2300)).toEqual({ providerWaitMs: 200, streamMs: 2000 });
    expect(completedResponseTiming(undefined, undefined, 200)).toEqual({ providerWaitMs: undefined, streamMs: undefined });
  });
});
