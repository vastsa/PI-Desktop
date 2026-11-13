import { expect, it } from "vitest";
import { buildSubagentDirectoryTool } from "./subagent-directory.js";
import type { DelegationChain } from "./delegation-history.js";

const recorded: DelegationChain[] = Array.from({ length: 105 }, (_, index) => ({
  delegateSessionId: `child-${index}`, delegationIds: [`child-${index}`], toolCallIds: [`task-${index}`],
  agentName: "explorer", latestDelegationId: `child-${index}`, latestStatus: "stopped",
  latestObjective: "x".repeat(900), readFiles: [], readLineCount: 0, lastActivityAt: 105 - index,
}));
const tool = buildSubagentDirectoryTool({ snapshot: () => ({ delegations: [], heartbeats: [], resumable: [], recorded }) });

it("bounds recorded directory pages without adding resumable ids", async () => {
  const first = await tool.execute("list", { limit: 1000 });
  expect(first.details).toMatchObject({ resumable: [], recorded: {
    total: 105, offset: 0, returned: 100, hasMore: true, nextOffset: 100,
  } });
  const text = first.content.find(block => block.type === "text");
  expect(text?.type === "text" && text.text).not.toContain("x".repeat(513));
  const last = await tool.execute("last", { offset: 100 });
  expect(last.details).toMatchObject({ recorded: { returned: 5, hasMore: false, nextOffset: null,
    entries: [100, 101, 102, 103, 104].map(index => ({ delegationId: `child-${index}` })) } });
  const beyond = await tool.execute("beyond", { offset: 200 });
  expect(beyond.details).toMatchObject({ recorded: { offset: 200, returned: 0, nextOffset: null, entries: [] } });
});

it.each([{ offset: "1" }, { limit: "100" }, { offset: Infinity }])("rejects invalid paging before reading history: %j", async params => {
  const guarded = buildSubagentDirectoryTool({ snapshot: () => { throw new Error("must not read history"); } });
  const result = await guarded.execute("bad", params);
  expect(result).toMatchObject({ isError: true, details: { error: { code: "SUBAGENT_LIST_INVALID_ARGUMENT" } } });
});

it("uses the same fractional and negative paging normalization as TaskRead", async () => {
  const page = await tool.execute("normalized", { offset: -1.5, limit: 1.5 });
  expect(page.details).toMatchObject({ recorded: { offset: 0, returned: 1, nextOffset: 1 } });
});
