import { expect, it } from "vitest";
import { MAX_RESUMABLE_CHAINS_PER_AGENT, type UiMessage } from "@pi-desktop/shared";
import { DelegationChainRegistry } from "./delegation-chain.js";
import { rebuildChainsFromTranscript } from "./delegation-history.js";
import { recordedSubagentReport } from "./subagent-content.js";
import { MAX_SUBAGENT_REPORT_CHARS } from "./subagent.js";

function task(id: string, status: string, resume?: string, time = 0): UiMessage {
  return { id, role: "tool", content: "", createdAt: new Date(1_700_000_000_000 + time).toISOString(),
    toolName: "Task", toolCallId: `call-${id}`, toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Inspect", ...(resume ? { resume } : {}) },
    toolResult: { details: { delegationId: id, status } } };
}
function output(id: string, content: string, agentName = "explorer"): UiMessage {
  return { id: `${id}-output-${agentName}`, role: "assistant", content, createdAt: new Date().toISOString(),
    parentToolCallId: `call-${id}`, agentName, status: "complete", thinking: "hidden reasoning" };
}

it("observes an evicted successor without restoring model resume authority or falling back to its old live record", () => {
  const history = [task("old", "stopped"), task("new", "completed", "old", 1),
    ...Array.from({ length: MAX_RESUMABLE_CHAINS_PER_AGENT }, (_, i) => task(`other-${i}`, "completed", undefined, i + 2))];
  const registry = new DelegationChainRegistry();
  registry.hydrate(rebuildChainsFromTranscript(history));
  expect(registry.lookup("old")).toBeUndefined();
  const oldRecord = { delegationId: "old", agentName: "explorer", status: "stopped" };
  const records = new Map([["old", oldRecord]]);
  const snapshot = JSON.stringify(history);
  const result = registry.readTargets(["old", "new", "old", "foreign"], history, records);
  expect(result).toMatchObject({ unknownIds: ["foreign"], selected: [{ delegationId: "new", status: "completed",
    record: undefined, requestedDelegationIds: ["old", "new"] }] });
  expect(registry.lookup("old")).toBeUndefined();
  expect(registry.resolveResume({ resume: "old", agentName: "explorer", runningDelegationIds: new Set() }))
    .toEqual({ ok: false, error: { kind: "unknown" } });
  expect(oldRecord.status).toBe("stopped");
  expect(JSON.stringify(history)).toBe(snapshot);
});

it("reads only the latest run's bounded visible report and never a sibling, reasoning, or prior report", () => {
  const history = [task("old", "stopped"), output("old", "Old partial output"), task("new", "completed", "old"),
    output("new", "Final output ".repeat(2_000)), output("new", "Foreign output", "other-agent"),
    output("sibling", "Sibling output")];
  const chain = rebuildChainsFromTranscript(history)[0];
  const frozen = JSON.stringify(history);
  const report = recordedSubagentReport(history, chain);
  expect(report).toContain("Final output");
  expect(report).toContain("[report truncated]");
  expect(report.length).toBeLessThanOrEqual(MAX_SUBAGENT_REPORT_CHARS);
  expect(report).not.toMatch(/Old partial|Foreign output|Sibling output|hidden reasoning/);
  const missing = history.filter(row => row.id !== "new-output-explorer");
  expect(recordedSubagentReport(missing, chain)).toContain("without a recorded report");
  expect(JSON.stringify(history)).toBe(frozen);
});

it("reports restart-interrupted history honestly without resurrecting a running execution", () => {
  const history = [task("old", "stopped"), task("new", "running", "old"), output("new", "Partial output")];
  const registry = new DelegationChainRegistry();
  registry.hydrate(rebuildChainsFromTranscript(history));
  const target = registry.resolveRead("old", history, new Map());
  expect(target).toMatchObject({ delegationId: "new", status: "interrupted", record: undefined });
  expect(recordedSubagentReport(history, target?.chain)).toBe("Recorded last assistant output (interrupted):\nPartial output");
  expect(registry.resolveRead("foreign", history, new Map())).toBeUndefined();
});
