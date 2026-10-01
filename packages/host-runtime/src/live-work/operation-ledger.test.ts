import { describe, expect, it } from "vitest";
import { LiveWorkOperationLedger, reduceOperationEvidence } from "./operation-ledger.js";

function ledger() {
  let operationId = 0;
  let messageId = 0;
  return new LiveWorkOperationLedger(
    { callId: "call-1", workBindingRevision: 3, workSessionId: "session-a" },
    () => `operation-${++operationId}`,
    () => `message-${++messageId}`,
  );
}

describe("LiveWorkOperationLedger", () => {
  it("registers once, reuses an identical provider request, and rejects changed parameters", () => {
    const subject = ledger();
    const created = subject.registerCandidate("provider-1", "Inspect the login flow");
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected operation creation");

    expect(subject.registerCandidate("provider-1", "Inspect the login flow")).toEqual({
      status: "replayed",
      operation: created.operation,
    });
    expect(subject.registerCandidate("provider-1", "Delete the login flow")).toEqual({ status: "conflict" });
    expect(subject.values()).toHaveLength(1);
  });

  it("caps unresolved admission without counting accepted running work", () => {
    const subject = ledger();
    for (let index = 0; index < 16; index += 1) {
      expect(subject.registerCandidate(`provider-${index}`, `task ${index}`).status).toBe("created");
    }
    expect(subject.registerCandidate("provider-over-cap", "one more")).toEqual({ status: "capacity" });

    for (let index = 0; index < 16; index += 1) {
      subject.update(`provider-${index}`, { admission: "accepted", execution: "running" });
    }
    expect(subject.registerCandidate("provider-after-admission", "another task").status).toBe("created");
  });

  it("preserves all accepted identities up to the call limit", () => {
    const subject = ledger();
    for (let index = 0; index < 256; index += 1) {
      expect(subject.registerCandidate(`provider-${index}`, `task ${index}`).status).toBe("created");
      subject.update(`provider-${index}`, { admission: "accepted", execution: "running" });
    }
    expect(subject.registerCandidate("provider-0", "task 0").status).toBe("replayed");
    expect(subject.registerCandidate("provider-256", "task 256")).toEqual({ status: "capacity" });
  });

  it("merges delayed acknowledgements monotonically around terminal evidence", () => {
    const subject = ledger();
    const created = subject.registerCandidate("provider-1", "Run the task");
    if (created.status !== "created") throw new Error("expected operation creation");

    const terminal = reduceOperationEvidence(created.operation, {
      admission: "accepted",
      execution: "completed",
      turnId: "turn-1",
      resultState: "pending",
    });
    const delayedAck = reduceOperationEvidence(terminal, {
      admission: "accepted",
      execution: "running",
    });
    const unknownLookup = reduceOperationEvidence(delayedAck, {
      admission: "unknown",
      execution: "unknown",
    });

    expect(delayedAck.execution).toBe("completed");
    expect(unknownLookup).toMatchObject({ admission: "accepted", execution: "completed", turnId: "turn-1" });
  });

  it("does not turn a known Host rejection into acceptance from unrelated activity", () => {
    const subject = ledger();
    const created = subject.registerCandidate("provider-1", "Run the task");
    if (created.status !== "created") throw new Error("expected operation creation");
    const rejected = reduceOperationEvidence(created.operation, { admission: "rejected", execution: "not-started" });

    expect(reduceOperationEvidence(rejected, { admission: "accepted", execution: "running", turnId: "other-turn" }))
      .toMatchObject({ admission: "rejected", execution: "not-started" });
  });
});
