import { describe, expect, it } from "vitest";

import { DEFAULT_RESTART_POLICY, RuntimeSupervisor, type SupervisorEvent } from "./runtime-supervisor.js";

function harness(options: {
  hostStarts?: Array<() => Promise<void>>;
  isUnrecoverable?: (error: unknown) => boolean;
  shuttingDown?: () => boolean;
  now?: () => number;
} = {}) {
  const events: SupervisorEvent[] = [];
  const sleeps: number[] = [];
  const starts = { host: 0, sidecar: 0 };
  const hostStarts = options.hostStarts ?? [];
  const supervisor = new RuntimeSupervisor({
    start: {
      host: async () => {
        const index = starts.host;
        starts.host += 1;
        const step = hostStarts[index];
        if (step) await step();
      },
      sidecar: async () => {
        starts.sidecar += 1;
      },
    },
    isUnrecoverable: options.isUnrecoverable,
    isShuttingDown: options.shuttingDown,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: options.now ?? (() => 1_000),
  });
  return { supervisor, events, sleeps, starts };
}

describe("RuntimeSupervisor", () => {
  it("restarts with the documented exponential backoff and reports success", async () => {
    const { supervisor, events, sleeps, starts } = harness();
    await supervisor.superviseRestart("sidecar");
    expect(starts.sidecar).toBe(1);
    expect(sleeps).toEqual([DEFAULT_RESTART_POLICY.baseDelayMs]);
    expect(events.map((event) => event.phase)).toEqual(["restarting", "restarted"]);
  });

  it("keeps retrying with a capped delay until the child comes back", async () => {
    const failing = () => Promise.reject(new Error("still down"));
    const { supervisor, events, sleeps, starts } = harness({
      hostStarts: [failing, failing, async () => undefined],
    });
    await supervisor.superviseRestart("host");
    expect(starts.host).toBe(3);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(events.filter((event) => event.phase === "restart_failed")).toHaveLength(2);
    expect(events.at(-1)?.phase).toBe("restarted");
    expect(supervisor.delayForAttempt(10)).toBe(DEFAULT_RESTART_POLICY.maxDelayMs);
  });

  it("gives up after the per-window budget and reports a fatal limit", async () => {
    const failing = () => Promise.reject(new Error("still down"));
    const { supervisor, events, starts } = harness({
      hostStarts: [failing, failing, failing, failing],
    });
    await supervisor.superviseRestart("host");
    expect(starts.host).toBe(DEFAULT_RESTART_POLICY.maxRestartsPerWindow);
    expect(events.at(-1)).toEqual({ kind: "host", phase: "fatal", reason: "limit" });
  });

  it("resets the budget once the window elapsed", async () => {
    let clock = 0;
    const failing = () => Promise.reject(new Error("still down"));
    const { supervisor, events } = harness({
      hostStarts: [failing, failing, failing, failing, failing, async () => undefined],
      now: () => clock,
    });
    await supervisor.superviseRestart("host");
    expect(events.at(-1)?.phase).toBe("fatal");
    clock = DEFAULT_RESTART_POLICY.windowMs + 1;
    events.length = 0;
    await supervisor.superviseRestart("host");
    // A fresh window admits three more attempts; the third one succeeds.
    expect(events.filter((event) => event.phase === "restarting")).toHaveLength(3);
    expect(events.at(-1)?.phase).toBe("restarted");
  });

  it("stops on the first unrecoverable failure instead of burning the budget", async () => {
    const refusal = Object.assign(new Error("schema too new"), { fatal: true });
    const { supervisor, events, starts } = harness({
      hostStarts: [() => Promise.reject(refusal), async () => undefined],
      isUnrecoverable: (error) => (error as { fatal?: boolean })?.fatal === true,
    });
    await supervisor.superviseRestart("host");
    expect(starts.host).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "host", phase: "fatal", reason: "unrecoverable", error: refusal });
  });

  it("joins a concurrent request for the same child and never restarts during shutdown", async () => {
    let shuttingDown = false;
    const { supervisor, starts, events } = harness({ shuttingDown: () => shuttingDown });
    const first = supervisor.superviseRestart("sidecar");
    const second = supervisor.superviseRestart("sidecar");
    expect(second).toBe(first);
    await first;
    expect(starts.sidecar).toBe(1);
    shuttingDown = true;
    await supervisor.superviseRestart("sidecar");
    expect(starts.sidecar).toBe(1);
    expect(events.filter((event) => event.phase === "restarting")).toHaveLength(1);
  });
});
