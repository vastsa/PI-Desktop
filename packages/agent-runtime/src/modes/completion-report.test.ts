import { expect, it } from "vitest";
import { parseCompletionReport } from "./completion-report.js";

const completed = {
  status: "completed", outcomes: [{ criterion: "Build", outcome: "met", evidence: "Build exited 0" }], remainingWork: [],
};

it("accepts bounded completed and blocked reports without treating model evidence as a gate verdict", () => {
  expect(parseCompletionReport(completed)).toEqual(completed);
  const blocked = { ...completed, status: "blocked", remainingWork: ["Obtain user approval"], blockerReason: "Approval is missing" };
  expect(parseCompletionReport(blocked)).toEqual(blocked);
});

it.each([
  null,
  { ...completed, status: "active" },
  { ...completed, maxTurns: null },
  { ...completed, input: "Replace the objective" },
  { ...completed, outcomes: [] },
  { ...completed, outcomes: Array.from({ length: 65 }, (_, i) => ({ ...completed.outcomes[0], criterion: String(i) })) },
  { ...completed, outcomes: [completed.outcomes[0], { ...completed.outcomes[0], criterion: " Build " }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], criterion: " " }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], criterion: "中".repeat(1366) }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], evidence: " " }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], evidence: "中".repeat(5462) }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], approved: true }] },
  { ...completed, outcomes: [{ ...completed.outcomes[0], outcome: "unverified" }] },
  { ...completed, blockerReason: "Already blocked" },
  { ...completed, remainingWork: ["Pending check"] },
  { ...completed, status: "blocked", blockerReason: " ", remainingWork: ["Pending check"] },
  { ...completed, status: "blocked", blockerReason: "No remaining work" },
  { ...completed, status: "blocked", blockerReason: "x".repeat(16385), remainingWork: ["Pending"] },
  { ...completed, status: "blocked", blockerReason: "Approval", remainingWork: Array(65).fill("Pending") },
  { ...completed, status: "blocked", blockerReason: "Approval", remainingWork: [" "] },
  { ...completed, status: "blocked", blockerReason: "Approval", remainingWork: ["x".repeat(4097)] },
  { ...completed, outcomes: Array.from({ length: 32 }, (_, i) => ({ criterion: String(i), outcome: "met", evidence: "x".repeat(16384) })) },
])("rejects contradictory, oversized or authority-changing report %j", (report) => {
  expect(typeof parseCompletionReport(report)).toBe("string");
});
