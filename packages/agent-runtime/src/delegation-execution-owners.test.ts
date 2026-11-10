import { afterEach, expect, it, vi } from "vitest";
import { DelegationExecutionOwners } from "./delegation-execution-owners.js";

afterEach(() => vi.restoreAllMocks());

it("revokes the local identity before awaiting cleanup and sends one end RPC", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const call = vi.fn(async (method: string) => method === "tools.execution.end" ? pending : undefined);
  const owners = new DelegationExecutionOwners(call);
  await owners.start("child", "parent-turn");
  const first = owners.identity("child");
  expect(first).toMatchObject({ turnId: "parent-turn", executionOwnerId: expect.stringMatching(/^subagent:/) });
  const ending = owners.end("child", "aborted");
  const duplicate = owners.end("child", "completed");
  try {
    expect(owners.identity("child")).toBeUndefined();
    expect(call.mock.calls.filter(([method]) => method === "tools.execution.end")).toHaveLength(1);
  } finally {
    finish();
    await Promise.all([ending, duplicate]);
  }
  await owners.start("child", "next-parent-turn");
  expect(owners.identity("child")?.runtimeId).toBe(first?.runtimeId);
  expect(owners.identity("child")?.executionOwnerId).not.toBe(first?.executionOwnerId);
  await owners.end("child", "completed");
});

it("cleans up a rejected registration without retaining local authority", async () => {
  const call = vi.fn(async (method: string) => { if (method === "tools.execution.start") throw new Error("rejected"); });
  const owners = new DelegationExecutionOwners(call);
  await expect(owners.start("child", "parent")).rejects.toThrow("rejected");
  expect(owners.identity("child")).toBeUndefined();
  expect(call.mock.calls.map(([method]) => method)).toEqual(["tools.execution.start", "tools.execution.end"]);
});

it("reports cleanup failure and still removes local execution authority", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const owners = new DelegationExecutionOwners(async method => { if (method === "tools.execution.end") throw new Error("disconnected"); });
  await owners.start("child", "parent");
  await owners.end("child", "error");
  expect(owners.identity("child")).toBeUndefined();
  expect(log).toHaveBeenCalledWith("[runtime] child execution cleanup failed", expect.any(Error));
});
