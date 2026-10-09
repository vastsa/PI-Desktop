import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleHeapTrim } from "./idle-gc.js";

describe("startIdleHeapTrim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the gc once per interval when every probe reports idle", () => {
    const gc = vi.fn();
    startIdleHeapTrim({ gc, busy: [() => false, () => false], intervalMs: 5 * 60 * 1000 });

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(gc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("does not run before the interval has elapsed", () => {
    const gc = vi.fn();
    startIdleHeapTrim({ gc, busy: [() => false], intervalMs: 5 * 60 * 1000 });

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(gc).not.toHaveBeenCalled();
  });

  it("stays skipped while the first family (DesktopAgentRuntime sessions) has a turn in flight", () => {
    const gc = vi.fn();
    startIdleHeapTrim({ gc, busy: [() => true, () => false], intervalMs: 5 * 60 * 1000 });

    vi.advanceTimersByTime(5 * 60 * 1000 * 3);
    expect(gc).not.toHaveBeenCalled();
  });

  it("stays skipped while the second family (native Pi sessions) has a turn in flight", () => {
    const gc = vi.fn();
    startIdleHeapTrim({ gc, busy: [() => false, () => true], intervalMs: 5 * 60 * 1000 });

    vi.advanceTimersByTime(5 * 60 * 1000 * 3);
    expect(gc).not.toHaveBeenCalled();
  });

  it("resumes once the busy family settles back to idle", () => {
    let busy = true;
    const gc = vi.fn();
    startIdleHeapTrim({ gc, busy: [() => busy], intervalMs: 5 * 60 * 1000 });

    vi.advanceTimersByTime(5 * 60 * 1000 * 2);
    expect(gc).not.toHaveBeenCalled();

    busy = false;
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it("stops trimming after the returned stop function is called", () => {
    const gc = vi.fn();
    const stop = startIdleHeapTrim({ gc, busy: [() => false], intervalMs: 5 * 60 * 1000 });

    stop();
    vi.advanceTimersByTime(5 * 60 * 1000 * 3);
    expect(gc).not.toHaveBeenCalled();
  });

  it("survives a throwing gc without disturbing later trims", () => {
    let calls = 0;
    const gc = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("gc exploded");
    });
    startIdleHeapTrim({ gc, busy: [() => false], intervalMs: 5 * 60 * 1000 });

    expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing busy probe by treating the trim as skipped", () => {
    const gc = vi.fn();
    startIdleHeapTrim({
      gc,
      busy: [
        () => {
          throw new Error("probe exploded");
        },
      ],
      intervalMs: 5 * 60 * 1000,
    });

    expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
    expect(gc).not.toHaveBeenCalled();
  });
});
