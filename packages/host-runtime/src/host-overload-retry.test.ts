import { TOOL_QUEUE_WAIT_MS } from "@pi-desktop/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProcess } from "./host-process.js";

/** The one rejection the Host produces before it handles a request (rpc/mod.rs). */
function overloaded(): Error {
  return Object.assign(new Error("host RPC capacity is exhausted"), {
    code: -32029,
    errorCode: "HOST_OVERLOADED",
  });
}

/** A transport with no child process; only `callOnce` decides the outcome. */
function bareHost(respond: () => Promise<unknown>) {
  const host = Object.assign(Object.create(HostProcess.prototype), {
    closed: false,
    available: true,
    disposed: false,
    child: {
      exitCode: null,
      killed: false,
      stdin: { writable: true, destroyed: false, write() {} },
    },
  }) as HostProcess;
  let attempts = 0;
  (host as any).callOnce = async () => {
    attempts += 1;
    return respond();
  };
  return { host, attempts: () => attempts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Host saturation retry", () => {
  it("keeps retrying for as long as the Host's own tool queue can hold a request", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    // Saturation that outlives the old ~0.75s budget by a wide margin: a tool
    // waiting on its class/session budget holds its request slot that long.
    const { host, attempts } = bareHost(async () => {
      if (Date.now() - started < TOOL_QUEUE_WAIT_MS - 1_000) throw overloaded();
      return { ok: true, content: [] };
    });
    // Attached up front so the RED run reports one assertion failure instead
    // of an unhandled rejection.
    const settled = host
      .call("tools.execute", { toolName: "Write" })
      .then(
        () => "ok",
        (error: unknown) => ({ error }),
      );
    await vi.advanceTimersByTimeAsync(TOOL_QUEUE_WAIT_MS + 5_000);

    await expect(settled).resolves.toBe("ok");
    expect(attempts()).toBeGreaterThan(1);
  });

  it("reports a Host that stays saturated instead of retrying forever", async () => {
    vi.useFakeTimers();
    const { host, attempts } = bareHost(async () => {
      throw overloaded();
    });

    const failure = host.call("session.get", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(failure).resolves.toMatchObject({ errorCode: "HOST_OVERLOADED" });
    expect(attempts()).toBeLessThan(50);
  });

  it("does not retry a failure the Host produced after handling the request", async () => {
    vi.useFakeTimers();
    const { host, attempts } = bareHost(async () => {
      throw Object.assign(new Error("host tool capacity did not become available in time"), {
        errorCode: "TIMEOUT",
      });
    });

    const failure = host.call("tools.execute", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(failure).resolves.toMatchObject({ errorCode: "TIMEOUT" });
    expect(attempts()).toBe(1);
  });
});
