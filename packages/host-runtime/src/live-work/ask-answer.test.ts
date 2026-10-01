import { describe, expect, it } from "vitest";
import { build, candidate } from "../../test/live-work-fixture.js";
import { parseLiveWorkIntent } from "./intent.js";

const receipt = async () => ({ status: "sent" as const, deliveryId: "receipt" });
const writes = (calls: string[]) => calls.filter((call) => /^(submit|steer|queue|stop|cancel):/.test(call));
const answerIntent = (options: string[][]) => ({
  kind: "respond-input",
  answers: options.map((labels, questionIndex) => ({ questionIndex, options: labels })),
});

describe("Live work spoken answers", () => {
  it("keeps only an answer that names the present questions' own options", () => {
    expect(parseLiveWorkIntent(answerIntent([["0.16.0-beta.1"], ["push main + tag"]]))).toEqual({
      kind: "respond-input",
      answers: [
        { questionIndex: 0, options: ["0.16.0-beta.1"] },
        { questionIndex: 1, options: ["push main + tag"] },
      ],
    });
    expect(parseLiveWorkIntent(answerIntent([["a", "b"]]))).toEqual({
      kind: "respond-input",
      answers: [{ questionIndex: 0, options: ["a", "b"] }],
    });
  });

  it("rejects anything the question could not have offered", () => {
    // Extra fields, including authority the model must never claim.
    expect(parseLiveWorkIntent({ ...answerIntent([["a"]]), sessionId: "another-session" })).toBeNull();
    expect(parseLiveWorkIntent({ ...answerIntent([["a"]]), permissionMode: "auto" })).toBeNull();
    expect(parseLiveWorkIntent({ ...answerIntent([["a"]]), answers: [{ questionIndex: 0, options: ["a"], answer: "a" }] })).toBeNull();
    // Malformed answers.
    expect(parseLiveWorkIntent({ kind: "respond-input" })).toBeNull();
    expect(parseLiveWorkIntent({ kind: "respond-input", answers: [] })).toBeNull();
    expect(parseLiveWorkIntent(answerIntent([[]]))).toBeNull();
    expect(parseLiveWorkIntent(answerIntent([["  "]]))).toBeNull();
    expect(parseLiveWorkIntent({ kind: "respond-input", answers: [{ questionIndex: -1, options: ["a"] }] })).toBeNull();
    expect(parseLiveWorkIntent({ kind: "respond-input", answers: [{ questionIndex: 8, options: ["a"] }] })).toBeNull();
    expect(parseLiveWorkIntent({ kind: "respond-input", answers: [{ questionIndex: 0.5, options: ["a"] }] })).toBeNull();
    expect(parseLiveWorkIntent(answerIntent([["a"], ["b"]])).kind).toBe("respond-input");
    expect(parseLiveWorkIntent({
      kind: "respond-input",
      answers: [{ questionIndex: 0, options: ["a"] }, { questionIndex: 0, options: ["b"] }],
    })).toBeNull();
    expect(parseLiveWorkIntent({
      kind: "respond-input",
      answers: [{ questionIndex: 0, options: ["a", "a"] }],
    })).toBeNull();
    expect(parseLiveWorkIntent({
      kind: "respond-input",
      answers: [{ questionIndex: 0, options: ["x".repeat(513)] }],
    })).toBeNull();
  });

  it("resolves the open question without creating, steering, or queueing work", async () => {
    const subject = build({ intent: answerIntent([["0.16.0-beta.1"], ["push main + tag"]]) });
    try {
      await subject.coordinator.receiveCandidate(
        { ...candidate, instruction: "0.16.0-beta.1, and push it" },
        receipt,
      );
      const operation = subject.coordinator.listOperations("call-1")[0];
      expect(operation?.admission).toBe("accepted");
      expect(operation?.execution).toBe("not-started");
      expect(operation?.targetTurnId).toBe("turn-1");
      expect(writes(subject.calls)).toEqual([]);
      expect(subject.calls).toContain("answer:session-a:0.16.0-beta.1,push main + tag");
    } finally {
      subject.coordinator.closeCall("call-1");
    }
  });

  it("reports a refused answer honestly and does not retry it", async () => {
    const subject = build({
      intent: answerIntent([["maybe"]]),
      onRespondInput: async () => ({ status: "rejected", message: "That answer does not match the question's own options." }),
    });
    try {
      await subject.coordinator.receiveCandidate({ ...candidate, instruction: "maybe" }, receipt);
      const operation = subject.coordinator.listOperations("call-1")[0];
      expect(operation?.admission).toBe("rejected");
      expect(operation?.execution).toBe("not-started");
      expect(operation?.failureCode).toBe("host-rejected");
      expect(operation?.summary).toContain("does not match");
      expect(writes(subject.calls)).toEqual([]);
      expect(subject.calls.filter((call) => call.startsWith("answer:"))).toHaveLength(1);
    } finally {
      subject.coordinator.closeCall("call-1");
    }
  });

  it("keeps an unknown answer dispatch unknown instead of answering twice", async () => {
    const subject = build({
      intent: answerIntent([["a"]]),
      onRespondInput: async () => {
        throw new Error("socket closed");
      },
    });
    try {
      await subject.coordinator.receiveCandidate({ ...candidate, instruction: "yes" }, receipt);
      const operation = subject.coordinator.listOperations("call-1")[0];
      expect(operation?.admission).toBe("unknown");
      expect(operation?.execution).toBe("unknown");
      expect(operation?.failureCode).toBe("dispatch-unknown");
      // The same provider request ID is the same answer: it is never resent.
      await subject.coordinator.receiveCandidate({ ...candidate, instruction: "yes" }, receipt);
      expect(subject.calls.filter((call) => call.startsWith("answer:"))).toHaveLength(1);
      expect(subject.coordinator.listOperations("call-1")).toHaveLength(1);
    } finally {
      subject.coordinator.closeCall("call-1");
    }
  });
});
