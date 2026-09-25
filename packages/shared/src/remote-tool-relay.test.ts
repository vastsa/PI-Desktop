import { describe, expect, it } from "vitest";

import {
  isBoundedRacpRelayJson,
  isValidRacpToolsAdvertiseParams,
  RACP_TOOL_RELAY_LIMITS,
} from "./racp.js";

function advertise(tool: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    tools: [{
      name: "mcp_corp_search",
      description: "Search release notes",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      timeoutMs: 5_000,
      workspaceFree: true,
      ...tool,
    }],
  };
}

describe("RACP relay tool contracts", () => {
  it("accepts only bounded tools explicitly marked workspace-free", () => {
    expect(isValidRacpToolsAdvertiseParams(advertise())).toBe(true);
    expect(isValidRacpToolsAdvertiseParams(advertise({ workspaceFree: false }))).toBe(false);
    expect(isValidRacpToolsAdvertiseParams(advertise({ workspaceFree: undefined }))).toBe(false);
  });

  it("rejects duplicate names, external schema references, and excessive depth", () => {
    const duplicated = advertise();
    duplicated.tools.push(duplicated.tools[0]!);
    expect(isValidRacpToolsAdvertiseParams(duplicated)).toBe(false);

    expect(isValidRacpToolsAdvertiseParams(advertise({
      inputSchema: { type: "object", $ref: "https://example.test/schema.json" },
    }))).toBe(false);

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < RACP_TOOL_RELAY_LIMITS.maxJsonDepth + 1; index += 1) nested = { properties: { next: nested } };
    expect(isValidRacpToolsAdvertiseParams(advertise({ inputSchema: { type: "object", properties: nested } }))).toBe(false);
  });

  it("bounds execution results and arguments by encoded JSON size", () => {
    expect(isBoundedRacpRelayJson({ text: "ok" })).toBe(true);
    expect(isBoundedRacpRelayJson({ text: "x".repeat(RACP_TOOL_RELAY_LIMITS.maxDescriptionBytes + 1) })).toBe(true);
    expect(isBoundedRacpRelayJson({ text: "x".repeat(RACP_TOOL_RELAY_LIMITS.maxResultBytes) })).toBe(false);
    expect(isBoundedRacpRelayJson({ value: Number.NaN })).toBe(false);
  });
});
