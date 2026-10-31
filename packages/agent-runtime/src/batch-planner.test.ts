import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeHost } from "./host-client.js";
import { BatchPlanner, withBatchTurn } from "./batch-planner.js";
import { toolExecutionMode } from "./tool-execution-policy.js";

function fixture(capability: unknown = { version: 1, supported: true }) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: RuntimeHost = { call: async <T>(method: string, params?: unknown) => {
    calls.push({ method, params });
    return (method === "tools.fileBatchCapabilities" ? capability
      : method === "tools.fileBatchRegister" ? { ticket: `ticket-${calls.length}` } : { ok: true }) as T;
  } };
  const planner = new BatchPlanner(host, "session");
  const register = (batch: object, args: object, ordinal = 0) => planner.register(batch, args, {
    ordinal, toolCallId: `call-${ordinal}`, toolName: "Write", args, delegationId: "delegate-root",
  });
  return { host, planner, calls, register };
}

describe("Host file batch bindings", () => {
  it.each([undefined, {}, { version: 2, supported: true }, { version: 1, supported: false }])("keeps writes sequential without a supported capability: %s", async (response) => {
    const { planner, register, calls } = fixture(response ?? null);
    await planner.negotiate(false);
    await register({}, {});
    expect(planner.supported).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["tools.fileBatchCapabilities"]);
    expect(toolExecutionMode("Write", planner.supported)).toBe("sequential");
    expect(toolExecutionMode("Edit", planner.supported)).toBe("sequential");
  });

  it("never looks up remote paths on the local Host", async () => {
    const { planner, calls } = fixture();
    await planner.negotiate(true);
    expect(planner.supported).toBe(false);
    expect(calls).toEqual([]);
  });

  it("only treats an unknown method as legacy, preserving real transport failures", async () => {
    const { planner, host } = fixture();
    host.call = vi.fn().mockRejectedValue(Object.assign(new Error("old Host"), { errorCode: "METHOD_NOT_FOUND" }));
    await expect(planner.negotiate(false)).resolves.toBeUndefined();
    const broken = fixture();
    broken.host.call = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(broken.planner.negotiate(false)).rejects.toThrow("connection lost");
  });

  it("negotiates once per runtime, including a legacy numeric method error", async () => {
    const { planner, host } = fixture();
    host.call = vi.fn().mockRejectedValue(Object.assign(new Error("legacy"), { code: -32601, errorCode: "NOT_FOUND" }));
    await planner.negotiate(false); await planner.negotiate(false);
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(planner.supported).toBe(false);
  });

  it("closes failed registrations and blocks the rest of preparation without dispatch", async () => {
    const { planner, host, register } = fixture(); await planner.negotiate(false);
    const calls: string[] = [];
    host.call = async <T>(method: string) => {
      calls.push(method);
      return (method === "tools.fileBatchRegister" ? {} : { ok: true }) as T;
    };
    const batch = {};
    await expect(register(batch, {})).rejects.toThrow("invalid file batch ticket");
    await expect(register(batch, {}, 1)).rejects.toThrow("invalid file batch ticket");
    expect(calls).toEqual(["tools.fileBatchRegister", "tools.fileBatchClose"]);
  });

  it("registers in source order, binds delegation and seals once before any execute", async () => {
    const { planner, calls, register } = fixture();
    await planner.negotiate(false);
    const batch = {}, a = { path: "a" }, b = { path: "b" };
    await register(batch, a); await register(batch, b, 3);
    await Promise.all([planner.waitForTurn(b), planner.waitForTurn(a)]);
    expect(calls.map((c) => c.method)).toEqual([
      "tools.fileBatchCapabilities", "tools.fileBatchRegister", "tools.fileBatchRegister", "tools.fileBatchSeal",
    ]);
    expect(calls[1].params).toMatchObject({ sessionId: "session", ordinal: 0, delegationId: "delegate-root", args: a });
    expect(calls[2].params).toMatchObject({ ordinal: 3, args: b });
    expect(await planner.execute(a, async () => planner.ticket("call-0"))).toBe("ticket-2");
    await planner.settle(a);
    expect(planner.ticket("call-0")).toBeUndefined();
    planner.settleBatch(batch); await planner.drain();
    expect(calls.at(-1)?.method).toBe("tools.fileBatchClose");
  });

  it.each(["argument validation", "mode denial"])("abandons a call rejected by %s outside the builtin executor", async (reason) => {
    const { planner, calls, register } = fixture();
    await planner.negotiate(false);
    const args = {}, batch = {};
    await register(batch, args);
    const tool: AgentTool = { name: "Write", label: "Write", description: "test", parameters: Type.Object({}), execute: async () => { throw new Error(reason); } };
    await expect(withBatchTurn(tool, planner).execute("call-0", args)).rejects.toThrow(reason);
    expect(calls.at(-1)).toMatchObject({ method: "tools.fileBatchAbandon", params: { ticket: "ticket-2" } });
  });

  it("abandons an aborted unstarted call and never invokes its executor", async () => {
    const { planner, register, calls } = fixture();
    await planner.negotiate(false);
    const args = {}; await register({}, args);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool: AgentTool = { name: "Write", label: "Write", description: "test", parameters: Type.Object({}), execute };
    await expect(withBatchTurn(tool, planner).execute("call-0", args, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    expect(calls.at(-1)?.method).toBe("tools.fileBatchAbandon");
  });

  it("keeps unrelated batches separate and makes batch cleanup idempotent", async () => {
    const { planner, register, calls } = fixture(); await planner.negotiate(false);
    const a = {}, b = {}, argsA = {}, argsB = {};
    await register(a, argsA); await register(b, argsB, 1);
    planner.settleBatch(a); planner.settleBatch(a); await planner.drain();
    expect(await planner.execute(argsB, async () => planner.ticket("call-1"))).toBeDefined();
    expect(calls.filter((c) => c.method === "tools.fileBatchClose")).toHaveLength(1);
    await planner.waitForTurn(argsB);
    expect(calls.at(-1)?.method).toBe("tools.fileBatchSeal");
  });

  it("isolates equal provider call IDs in concurrent parent/delegate executors", async () => {
    const { planner, register } = fixture(); await planner.negotiate(false);
    const parent = {}, child = {};
    await register({}, parent); await register({}, child);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = planner.execute(parent, async () => { await gate; return planner.ticket("call-0"); });
    const second = planner.execute(child, async () => { release(); await gate; return planner.ticket("call-0"); });
    expect(await Promise.all([first, second])).toEqual(["ticket-2", "ticket-3"]);
    expect(planner.ticket("call-0")).toBeUndefined();
  });
});
