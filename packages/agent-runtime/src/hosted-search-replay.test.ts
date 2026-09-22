import { describe, expect, it, vi } from "vitest";
import { hostedSearchFromMessage, type HostedSearch } from "@pi-desktop/shared";
import { restoreHostedSearchReplay } from "./hosted-search-replay.js";

function stored(replay: HostedSearch["replay"]): HostedSearch {
  return { status: "completed", rounds: [], replay };
}

/** 捕获诊断输出：降级必须可观测，而不是静默丢弃。 */
function withCapturedWarnings<T>(run: () => T): { result: T; warnings: unknown[] } {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = run();
    return { result, warnings: spy.mock.calls };
  } finally {
    spy.mockRestore();
  }
}

describe("stored hosted-search replay boundary", () => {
  it("keeps display-only old records readable without manufacturing replay", () => {
    expect(restoreHostedSearchReplay(undefined)).toEqual([]);
    expect(restoreHostedSearchReplay(stored(undefined))).toEqual([]);
  });

  it("restores old search items without name or arguments and does not mutate storage", () => {
    const search = stored([{
      type: "hostedSearch",
      phase: "web_search_call",
      blockId: "ws_fixture",
      wire: { type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "fixture" } },
    }]);
    const snapshot = structuredClone(search);
    const result = restoreHostedSearchReplay(search);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "hostedSearch", phase: "web_search_call" });
    expect(result[0]).not.toHaveProperty("name");
    expect(result[0]).not.toHaveProperty("arguments");
    expect(search).toEqual(snapshot);
    expect(result[0]).not.toBe(search.replay?.[0]);
  });

  it("retains paired server search input and opaque result content in order", () => {
    const search = stored([
      { type: "hostedSearch", phase: "server_tool_use", blockId: "srv_fixture", name: "web_search", input: { query: "fixture" } },
      { type: "hostedSearch", phase: "web_search_tool_result", blockId: "srv_fixture", wire: { type: "web_search_tool_result", tool_use_id: "srv_fixture", content: [{ type: "web_search_result", encrypted_content: "opaque-fixture" }] } },
    ]);
    expect(restoreHostedSearchReplay(search)).toMatchObject(search.replay!);
  });

  it("classifies a malformed stored replay container before array operations", () => {
    const invalid: HostedSearch = JSON.parse('{"status":"completed","rounds":[],"replay":{}}');
    expect(() => restoreHostedSearchReplay(invalid)).toThrow(
      expect.objectContaining({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" }),
    );
  });

  it("drops the whole replay rather than failing a turn on an unreplayable block", () => {
    const { result, warnings } = withCapturedWarnings(() => restoreHostedSearchReplay(stored([
      { type: "hostedSearch", phase: "server_tool_use", blockId: "srv_fixture", name: "web_search", input: { query: "fixture" } },
      { type: "hostedSearch", phase: "unsupported", blockId: "fixture" },
    ])));
    // 整条丢弃：留下配对的另一半会制造适配器无法接受的孤立块。
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("reads a stored record the persistence layer writes when a gateway drops ids", () => {
    const search = hostedSearchFromMessage({
      content: [{ type: "hostedSearch", phase: "web_search_call", status: "completed" }],
    });
    expect(search?.replay).toHaveLength(1);
    const { result, warnings } = withCapturedWarnings(() => restoreHostedSearchReplay(search));
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
