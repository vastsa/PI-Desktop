import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { buildJobTools } from "./background-job-tools.js";
import type { RuntimeHost } from "./host-client.js";

afterEach(() => vi.useRealTimers());

function fixture(remote = false) {
  const delegate = (name: string): AgentTool => ({
    name, label: name, description: name,
    parameters: Type.Object({ delegationIds: Type.Optional(Type.Array(Type.String())) }),
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "delegate report" }], details: { delegations: [] } })),
  });
  const delegates = { wait: delegate("TaskWait"), list: delegate("TaskList"), stop: delegate("TaskStop") };
  const snapshot = { job: { kind: "bash", id: "process" }, state: "failed", exitCode: 1, stdout: "", stderr: "assertion failed", truncated: false };
  const dispatch = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === "backgroundJobs.capabilities") return { version: 1, supported: true };
    if (method === "backgroundJobs.list") return { tasks: [snapshot] };
    return snapshot;
  });
  const host: RuntimeHost = { call: async <T>(method: string, params?: unknown) => await dispatch(method, params) as T };
  const [wait, list, stop] = buildJobTools(delegates, {
    host, sessionId: "owner", remote, defaultTimeoutSeconds: 600, maxTimeoutSeconds: 900,
    wait: (run, signal) => run(signal ?? new AbortController().signal),
  });
  return { delegates, dispatch, snapshot, wait, list, stop };
}

describe("session job controls", () => {
  it("lists, reads and stops the same explicit Bash job with the bound session", async () => {
    const { list, wait, stop, dispatch, snapshot } = fixture();
    const listed = await list.execute("list", {});
    expect(listed.details).toMatchObject({ delegations: [], backgroundJobs: { supported: true, tasks: [snapshot] } });
    expect((await wait.execute("wait", { job: snapshot.job })).details).toEqual({ status: "completed", job: snapshot });
    expect((await stop.execute("stop", { job: snapshot.job, sessionId: "foreign" })).details).toEqual({ status: "completed", job: snapshot });
    expect(dispatch).toHaveBeenLastCalledWith("backgroundJobs.stop", { sessionId: "owner", id: "process", timeoutMs: 1000 });
  });

  it("preserves default delegation targets and routes an explicit delegation", async () => {
    const { wait, stop, dispatch, delegates } = fixture();
    await wait.execute("wait", {});
    await stop.execute("stop", {});
    expect(dispatch).not.toHaveBeenCalled();
    await wait.execute("one", { job: { kind: "delegation", id: "delegate" }, timeoutSeconds: 12 });
    expect(delegates.wait.execute).toHaveBeenLastCalledWith("one", { delegationIds: ["delegate"], timeoutSeconds: 12 }, undefined, undefined);
    await stop.execute("one", { job: { kind: "delegation", id: "delegate" } });
    expect(delegates.stop.execute).toHaveBeenLastCalledWith("one", { delegationIds: ["delegate"] }, undefined, undefined);
  });

  it.each([undefined, [], ["delegate"], ["delegate", "delegate"]].map(delegationIds => ({ delegationIds })))(
    "accepts redundant delegation selectors (%j) and ignores single-job wait options",
    async ({ delegationIds }) => {
      const { wait, stop, dispatch, delegates } = fixture();
      const params = {
        job: { kind: "delegation", id: "delegate" }, delegationIds,
        mode: "any", minCompleted: 2, timeoutSeconds: 180,
      };
      const signal = new AbortController().signal;
      const update = vi.fn();
      const waitResult = await wait.execute("wait", params, signal, update);
      expect(waitResult.content).toEqual([{ type: "text", text: "delegate report" }]);
      expect(delegates.wait.execute).toHaveBeenCalledWith("wait", {
        delegationIds: ["delegate"], timeoutSeconds: 180,
      }, signal, update);
      await stop.execute("stop", params, signal, update);
      expect(delegates.stop.execute).toHaveBeenCalledWith("stop", {
        delegationIds: ["delegate"],
      }, signal, update);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([["other"], ["delegate", "other"], "delegate", null].map(delegationIds => ({ delegationIds })))(
    "rejects conflicting or malformed delegation selectors (%j) before dispatch",
    async ({ delegationIds }) => {
      const { wait, stop, dispatch, delegates } = fixture();
      const params = { job: { kind: "delegation", id: "delegate" }, delegationIds };
      await expect(wait.execute("wait", params)).rejects.toThrow("omit delegationIds or pass only job.id");
      await expect(stop.execute("stop", params)).rejects.toThrow("omit delegationIds or pass only job.id");
      expect(delegates.wait.execute).not.toHaveBeenCalled();
      expect(delegates.stop.execute).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { delegationIds: [] },
    { mode: "all" },
    { minCompleted: 1 },
    { delegationIds: [], mode: "all", minCompleted: 1 },
    { delegationIds: [], mode: "any", minCompleted: 1 },
  ])("accepts redundant Bash selectors (%j) without dispatching to delegates", async selectors => {
    const { wait, stop, dispatch, delegates, snapshot } = fixture();
    const args = { job: snapshot.job, ...selectors, timeoutSeconds: 12, sessionId: "foreign" };
    expect((await wait.execute("wait", args)).details).toEqual({ status: "completed", job: snapshot });
    expect(dispatch).toHaveBeenLastCalledWith("backgroundJobs.wait", { sessionId: "owner", id: "process", timeoutMs: 0 });
    expect((await stop.execute("stop", args)).details).toEqual({ status: "completed", job: snapshot });
    expect(dispatch).toHaveBeenLastCalledWith("backgroundJobs.stop", { sessionId: "owner", id: "process", timeoutMs: 1000 });
    expect(delegates.wait.execute).not.toHaveBeenCalled();
    expect(delegates.stop.execute).not.toHaveBeenCalled();
  });

  it.each([
    { delegationIds: ["other"] }, { delegationIds: ["process"] },
    { delegationIds: null }, { delegationIds: "process" }, { delegationIds: {} },
    { mode: [] }, { mode: "invalid" }, { mode: null },
    { minCompleted: [] }, { minCompleted: 2 }, { minCompleted: 0 },
    { minCompleted: "1" }, { minCompleted: null },
  ])("rejects conflicting or malformed Bash selectors (%j) before dispatch", async selectors => {
    const { wait, stop, dispatch, delegates } = fixture();
    const args = { job: { kind: "bash", id: "process" }, ...selectors };
    await expect(wait.execute("wait", args)).rejects.toThrow("A Bash job accepts only");
    await expect(stop.execute("stop", args)).rejects.toThrow("A Bash job accepts only");
    expect(dispatch).not.toHaveBeenCalled();
    expect(delegates.wait.execute).not.toHaveBeenCalled();
    expect(delegates.stop.execute).not.toHaveBeenCalled();
  });

  it("returns running at the deadline and never requests a stop", async () => {
    vi.useFakeTimers();
    const { wait, dispatch, snapshot } = fixture();
    dispatch.mockImplementation(async method => {
      if (method.endsWith("capabilities")) return { version: 1, supported: true };
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { ...snapshot, state: "running", exitCode: null };
    });
    const result = wait.execute("wait", { job: snapshot.job, delegationIds: [], mode: "all", minCompleted: 1, timeoutSeconds: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).details).toMatchObject({ status: "timeout", job: { state: "running", exitCode: null } });
    expect(dispatch.mock.calls.map(call => call[0])).not.toContain("backgroundJobs.stop");
  });

  it("abandons an in-flight wait promptly without stopping, and observes a late failure", async () => {
    const { wait, dispatch, snapshot } = fixture();
    let fail: (error: Error) => void = () => {};
    dispatch.mockImplementation(async method => method.endsWith("capabilities")
      ? { version: 1, supported: true }
      : new Promise((_, reject) => { fail = reject; }));
    const controller = new AbortController();
    const result = wait.execute("wait", { job: snapshot.job, delegationIds: [], mode: "any", minCompleted: 1 }, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ errorCode: "TOOL_ABORTED" });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith("backgroundJobs.wait", expect.anything()));
    controller.abort();
    await assertion;
    fail(new Error("late transport failure"));
    await Promise.resolve();
    expect(dispatch.mock.calls.map(call => call[0])).not.toContain("backgroundJobs.stop");
  });

  it.each(["capabilities", "wait"])("includes a stalled %s RPC in the first wait deadline", async stalled => {
    vi.useFakeTimers();
    const { wait, dispatch, snapshot } = fixture();
    let rejectLate!: (error: Error) => void;
    dispatch.mockImplementation(async method => method.endsWith(stalled)
      ? new Promise((_, reject) => { rejectLate = reject; })
      : { version: 1, supported: true });
    const pending = wait.execute("wait", { job: snapshot.job, timeoutSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.details).toEqual({ status: "timeout", job: snapshot.job, snapshotAvailable: false });
    rejectLate(new Error("late transport error"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(stalled === "capabilities"
      ? ["backgroundJobs.capabilities"] : ["backgroundJobs.capabilities", "backgroundJobs.wait"]);
  });

  it("reports remote and older Hosts as unavailable while retaining delegation results", async () => {
    for (const remote of [true, false]) {
      const { list, wait, stop, dispatch, snapshot } = fixture(remote);
      dispatch.mockRejectedValue({ code: -32601 });
      expect((await list.execute("list", {})).details).toMatchObject({ delegations: [], backgroundJobs: { supported: false, tasks: [] } });
      await expect(wait.execute("wait", { job: snapshot.job })).rejects.toThrow("does not support");
      await expect(stop.execute("stop", { job: snapshot.job })).rejects.toThrow("does not support");
      if (remote) expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("propagates transport errors instead of presenting an empty list", async () => {
    const { list, dispatch } = fixture();
    dispatch.mockRejectedValue(new Error("connection lost"));
    await expect(list.execute("list", {})).rejects.toThrow("connection lost");
  });
});
