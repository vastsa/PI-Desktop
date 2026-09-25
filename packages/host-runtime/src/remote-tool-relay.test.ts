import { describe, expect, it, vi } from "vitest";
import { RACP_TOOL_RELAY_LIMITS } from "@pi-desktop/shared";

import { RemoteToolRelay } from "./remote-tool-relay.js";

function descriptor(name = "mcp_corp_search") {
  return {
    name,
    description: "Search release notes",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    timeoutMs: 1_000,
    workspaceFree: true as const,
  };
}

function call(turnId: string, toolName = "mcp_corp_search") {
  return {
    executionId: `exec-${turnId}`,
    sessionId: "s1",
    turnId,
    toolCallId: `call-${turnId}`,
    toolName,
    args: { query: "release notes" },
  };
}

function capture(relay: RemoteToolRelay, turnId: string) {
  const catalog = relay.captureCatalog("s1");
  relay.bindTurn(catalog.id, "s1", turnId);
  return catalog;
}

describe("RemoteToolRelay", () => {
  it("replaces one connection/session catalog and invalidates removed entries", async () => {
    const relay = new RemoteToolRelay();
    const execute = vi.fn(async () => ({ result: "ok", isError: false }));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request: execute });
    const first = capture(relay, "turn-old");

    relay.advertise({
      connectionId: "owner-a",
      sessionId: "s1",
      tools: [descriptor("mcp_corp_calendar")],
      request: execute,
    });
    const replacement = capture(relay, "turn-new");

    expect(first.tools.map((tool) => tool.name)).toEqual(["mcp_corp_search"]);
    expect(replacement.tools.map((tool) => tool.name)).toEqual(["mcp_corp_calendar"]);
    await expect(relay.execute(call("turn-old"))).resolves.toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cleans a disconnected owner and never reroutes a stale turn to another connection", async () => {
    const relay = new RemoteToolRelay();
    const oldOwnerRequest = vi.fn(async () => ({ result: "old", isError: false }));
    const newOwnerRequest = vi.fn(async () => ({ result: "new", isError: false }));
    relay.advertise({ connectionId: "owner-old", sessionId: "s1", tools: [descriptor()], request: oldOwnerRequest });
    capture(relay, "turn-old-owner");

    relay.clearConnection("owner-old");
    relay.advertise({ connectionId: "owner-new", sessionId: "s1", tools: [descriptor()], request: newOwnerRequest });
    const newCatalog = capture(relay, "turn-new-owner");

    await expect(relay.execute(call("turn-old-owner"))).resolves.toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
    expect(oldOwnerRequest).not.toHaveBeenCalled();
    expect(newOwnerRequest).not.toHaveBeenCalled();
    await expect(relay.execute(call("turn-new-owner"))).resolves.toMatchObject({ ok: true, content: "new" });
    expect(newCatalog.tools).toHaveLength(1);
    expect(newOwnerRequest).toHaveBeenCalledTimes(1);
  });

  it("omits ambiguous names advertised by multiple owners", async () => {
    const relay = new RemoteToolRelay();
    const requestA = vi.fn(async () => ({ result: "a", isError: false }));
    const requestB = vi.fn(async () => ({ result: "b", isError: false }));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request: requestA });
    relay.advertise({ connectionId: "owner-b", sessionId: "s1", tools: [descriptor()], request: requestB });
    const catalog = capture(relay, "turn-collision");

    expect(catalog.tools).toEqual([]);
    await expect(relay.execute(call("turn-collision"))).resolves.toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
    expect(requestA).not.toHaveBeenCalled();
    expect(requestB).not.toHaveBeenCalled();
  });

  it("bounds the combined session catalog before replacing an existing registration", () => {
    const relay = new RemoteToolRelay();
    const request = async () => ({ result: "ok", isError: false });
    const tools = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => descriptor(`${prefix}_${index}`));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: tools("mcp_first", 40), request });

    expect(() => relay.advertise({
      connectionId: "owner-b",
      sessionId: "s1",
      tools: tools("mcp_second", 25),
      request,
    })).toThrow("session tool catalog exceeds relay limits");

    expect(capture(relay, "turn-bounded").tools).toHaveLength(40);
  });

  it("bounds the encoded combined catalog across owners", () => {
    const relay = new RemoteToolRelay();
    const request = async () => ({ result: "ok", isError: false });
    const largeDescriptor = (name: string) => ({
      ...descriptor(name),
      inputSchema: { type: "object", description: "x".repeat(60 * 1024) },
    });

    relay.advertise({
      connectionId: "owner-a",
      sessionId: "s1",
      tools: Array.from({ length: 7 }, (_, index) => largeDescriptor(`mcp_first_${index}`)),
      request,
    });
    expect(() => relay.advertise({
      connectionId: "owner-b",
      sessionId: "s1",
      tools: [largeDescriptor("mcp_second_0"), largeDescriptor("mcp_second_1")],
      request,
    })).toThrow("session tool catalog exceeds relay limits");

    expect(capture(relay, "turn-byte-bounded").tools).toHaveLength(7);
  });

  it("normalizes a timeout and never retries the tool", async () => {
    const relay = new RemoteToolRelay();
    const request = vi.fn(async () => { throw new Error("connection closed"); });
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request });
    capture(relay, "turn-timeout");

    await expect(relay.execute(call("turn-timeout"))).resolves.toMatchObject({
      ok: false,
      errorCode: "TOOL_FAILED",
      content: { code: "TOOL_FAILED" },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("tool/execute", expect.objectContaining({ toolName: "mcp_corp_search" }), 1_000);
  });

  it("rejects oversized arguments before contacting the owner", async () => {
    const relay = new RemoteToolRelay();
    const request = vi.fn(async () => ({ result: "ok", isError: false }));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request });
    capture(relay, "turn-large-args");
    await expect(relay.execute({
      ...call("turn-large-args"),
      args: { content: "x".repeat(300 * 1024) },
    })).resolves.toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized results from the owner", async () => {
    const relay = new RemoteToolRelay();
    const malformed = vi.fn(async () => ({ result: "ok" }));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request: malformed });
    capture(relay, "turn-malformed-result");
    await expect(relay.execute(call("turn-malformed-result"))).resolves.toMatchObject({
      ok: false,
      errorCode: "TOOL_FAILED",
    });

    const oversized = vi.fn(async () => ({
      result: "x".repeat(RACP_TOOL_RELAY_LIMITS.maxResultBytes + 1),
      isError: false,
    }));
    relay.advertise({ connectionId: "owner-a", sessionId: "s1", tools: [descriptor()], request: oversized });
    capture(relay, "turn-oversized-result");
    await expect(relay.execute(call("turn-oversized-result"))).resolves.toMatchObject({
      ok: false,
      errorCode: "TOOL_FAILED",
    });
    expect(oversized).toHaveBeenCalledTimes(1);
  });
});
