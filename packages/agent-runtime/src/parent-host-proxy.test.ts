import { afterEach, describe, expect, it, vi } from "vitest";
import { ParentHostProxy } from "./parent-host-proxy.js";

function stubStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any, cb?: any) => {
    if (typeof cb === "function") cb();
    return true;
  }) as any);
}

describe("ParentHostProxy RPC deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("honors a per-call timeout", async () => {
    vi.useFakeTimers();
    const stdout = stubStdout();
    try {
      const proxy = new ParentHostProxy();
      const pending = proxy.call("project.instructions.resolve", {}, 25);
      const rejected = expect(pending).rejects.toThrow(
        "parent host proxy timeout: project.instructions.resolve",
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      await proxy.dispose();
    } finally {
      stdout.mockRestore();
    }
  });

  it("bounds the default Bash command deadline until the host responds", async () => {
    vi.useFakeTimers();
    const stdout = stubStdout();
    try {
      const proxy = new ParentHostProxy();
      const pending = proxy.call("tools.execute", { toolName: "Bash" });
      const request = JSON.parse(String(stdout.mock.calls[0][0]));
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(189_999);
      expect(settled).toBe(false);
      proxy.handleParentMessage({ id: request.id, result: { ok: true } });
      await expect(pending).resolves.toEqual({ ok: true });
      await proxy.dispose();
    } finally {
      stdout.mockRestore();
    }
  });

  it("adds permission and buffer time to explicit Bash command timeouts", async () => {
    vi.useFakeTimers();
    const stdout = stubStdout();
    try {
      const proxy = new ParentHostProxy();
      const pending = proxy.call("tools.execute", {
        toolName: "Bash",
        timeoutMs: 1_000,
      });
      const request = JSON.parse(String(stdout.mock.calls[0][0]));
      const rejection = expect(pending).rejects.toThrow("parent host proxy timeout");

      await vi.advanceTimersByTimeAsync(131_000);
      await expect(Promise.resolve()).resolves.toBeUndefined();
      await rejection;
      expect(request.params.method).toBe("tools.execute");
      await proxy.dispose();
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps ordinary calls bounded and clears their timer after a response", async () => {
    vi.useFakeTimers();
    const stdout = stubStdout();
    try {
      const proxy = new ParentHostProxy();
      const pending = proxy.call("tools.abort", {
        sessionId: "session-1",
        toolCallId: "tool-1",
      });
      const request = JSON.parse(String(stdout.mock.calls[0][0]));
      proxy.handleParentMessage({ id: request.id, result: { ok: true } });
      await expect(pending).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(130_000);
      await proxy.dispose();
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects a default-deadline command immediately when the parent closes", async () => {
    const stdout = stubStdout();
    try {
      const proxy = new ParentHostProxy();
      const closed = vi.fn();
      proxy.onClose(closed);
      const pending = proxy.call("tools.execute", { toolName: "Bash" });
      (proxy as any).handleParentClose(new Error("parent host died"));
      await expect(pending).rejects.toThrow("parent host died");
      expect(closed).toHaveBeenCalledOnce();
      await proxy.dispose();
    } finally {
      stdout.mockRestore();
    }
  });

  it("cleans listeners across repeated proxy lifecycles", async () => {
    const stdout = stubStdout();
    try {
      for (let index = 0; index < 3; index += 1) {
        const proxy = new ParentHostProxy();
        const pending = proxy.call("tools.execute", { toolName: "Bash" });
        const request = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        proxy.handleParentMessage({ id: request.id, result: { ok: true } });
        await expect(pending).resolves.toEqual({ ok: true });
        await proxy.dispose();
      }
    } finally {
      stdout.mockRestore();
    }
  });
});
