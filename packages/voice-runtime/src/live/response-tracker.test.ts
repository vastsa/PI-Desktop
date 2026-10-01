import { describe, expect, it } from "vitest";
import { RealtimeResponseTracker } from "./response-tracker.js";

describe("RealtimeResponseTracker", () => {
  it("cancels active output and drops late audio and completion from an interrupted response", () => {
    const tracker = new RealtimeResponseTracker();
    tracker.add("response-old");
    tracker.interrupt();

    expect(tracker.shouldSendCancel()).toBe(true);
    expect(tracker.shouldAcceptAudio("response-old")).toBe(false);
    expect(tracker.finish("response-old")).toBe(true);
    expect(tracker.shouldSendCancel()).toBe(false);
    expect(tracker.shouldAcceptAudio("response-old")).toBe(false);

    tracker.add("response-new");
    expect(tracker.shouldAcceptAudio("response-new")).toBe(true);
    expect(tracker.finish("response-new")).toBe(false);
  });
});
