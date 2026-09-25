import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolRelayPort } from "@pi-desktop/agent-host";

import { harness, OWNER_TOKEN, VIEWER_TOKEN, flush } from "./test-harness.js";

function relaySpy() {
  const advertisements: Array<Parameters<ToolRelayPort["advertise"]>[0]> = [];
  const cleared: string[] = [];
  const relay: ToolRelayPort = {
    advertise: (input) => advertisements.push(input),
    clearConnection: (connectionId) => cleared.push(connectionId),
    captureCatalog: () => ({ id: "snapshot", tools: [] }),
    bindTurn: vi.fn(),
    releaseCatalog: vi.fn(),
    releaseTurn: vi.fn(),
    async execute() {
      return { ok: false, errorCode: "TOOL_FAILED", content: { code: "TOOL_FAILED" } };
    },
  };
  return { relay, advertisements, cleared };
}

describe("RACP reverse tool relay", () => {
  const clients: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("accepts an owner advertisement for a workspace-free tool", async () => {
    const spy = relaySpy();
    const h = await harness({ toolRelay: spy.relay });
    const { client } = await h.connect(OWNER_TOKEN, {
      onServerRequest: async (method) => {
        if (method !== "tool/execute") throw new Error("unexpected server request");
        return { result: { content: "release 12" }, isError: false };
      },
    });
    clients.push(client);

    expect(client.initialized?.capabilities.toolRelay).toBe(true);
    await expect(client.request("tools/advertise", {
      sessionId: "s1",
      tools: [{
        name: "mcp_corp_search",
        description: "Search the corporate release index",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        timeoutMs: 5_000,
        workspaceFree: true,
      }],
    })).resolves.toMatchObject({ advertised: 1 });
    expect(spy.advertisements).toHaveLength(1);

    await expect(spy.advertisements[0]?.request("tool/execute", { toolName: "mcp_corp_search" }, 500))
      .resolves.toEqual({ result: { content: "release 12" }, isError: false });
    const connectionId = spy.advertisements[0]?.connectionId;
    await client.close();
    await flush();
    expect(spy.cleared).toContain(connectionId);
  });

  it("rejects viewer advertisements and workspace-required tools", async () => {
    const spy = relaySpy();
    const h = await harness({ toolRelay: spy.relay });
    const { client: viewer } = await h.connect(VIEWER_TOKEN);
    clients.push(viewer);
    await expect(viewer.request("tools/advertise", { sessionId: "s1", tools: [] }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const { client: owner } = await h.connect(OWNER_TOKEN);
    clients.push(owner);
    await expect(owner.request("tools/advertise", {
      sessionId: "s1",
      tools: [{
        name: "plugin_workspace_read",
        description: "Read workspace file",
        inputSchema: { type: "object", properties: {} },
        timeoutMs: 1_000,
        workspaceFree: false,
      }],
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(spy.advertisements).toHaveLength(0);
  });
});
