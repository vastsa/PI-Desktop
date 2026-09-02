import { describe, it, expect } from "vitest";
import {
  A2A_TASK_STATES,
  A2A_TERMINAL_TASK_STATES,
  isA2ATaskState,
  isA2ATerminalState,
  canTransitionA2ATask,
  isA2APart,
  A2A_RPC_METHODS,
  A2A_NOTIFICATIONS,
  A2A_ERROR_CODES,
  type A2ATaskState,
} from "./a2a.js";

describe("A2A task states", () => {
  it("recognizes every declared state and rejects unknowns", () => {
    for (const state of A2A_TASK_STATES) {
      expect(isA2ATaskState(state)).toBe(true);
    }
    expect(isA2ATaskState("bogus")).toBe(false);
    expect(isA2ATaskState(42)).toBe(false);
  });

  it("classifies terminal states", () => {
    expect(isA2ATerminalState("completed")).toBe(true);
    expect(isA2ATerminalState("failed")).toBe(true);
    expect(isA2ATerminalState("canceled")).toBe(true);
    expect(isA2ATerminalState("rejected")).toBe(true);
    expect(isA2ATerminalState("working")).toBe(false);
    expect(isA2ATerminalState("submitted")).toBe(false);
    expect(A2A_TERMINAL_TASK_STATES.size).toBe(4);
  });
});

describe("A2A task transitions", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransitionA2ATask("submitted", "working")).toBe(true);
    expect(canTransitionA2ATask("working", "completed")).toBe(true);
    expect(canTransitionA2ATask("working", "input-required")).toBe(true);
    expect(canTransitionA2ATask("input-required", "working")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    const terminal: A2ATaskState[] = ["completed", "canceled", "failed", "rejected"];
    for (const from of terminal) {
      for (const to of A2A_TASK_STATES) {
        expect(canTransitionA2ATask(from, to)).toBe(false);
      }
    }
  });

  it("rejects an illegal jump from a paused state to completed", () => {
    // input-required must resume to working before completing.
    expect(canTransitionA2ATask("input-required", "completed")).toBe(false);
    expect(canTransitionA2ATask("auth-required", "completed")).toBe(false);
  });
});

describe("A2A part validation", () => {
  it("accepts text, file, and data parts", () => {
    expect(isA2APart({ kind: "text", text: "hi" })).toBe(true);
    expect(isA2APart({ kind: "file", file: { name: "a.txt" } })).toBe(true);
    expect(isA2APart({ kind: "data", data: { x: 1 } })).toBe(true);
  });

  it("rejects malformed parts", () => {
    expect(isA2APart({ kind: "text" })).toBe(false);
    expect(isA2APart({ kind: "image" })).toBe(false);
    expect(isA2APart(null)).toBe(false);
    expect(isA2APart("text")).toBe(false);
  });
});

describe("A2A wire constants", () => {
  it("namespaces every RPC method under a2a.", () => {
    for (const method of Object.values(A2A_RPC_METHODS)) {
      expect(method.startsWith("a2a.")).toBe(true);
    }
  });

  it("defines the streaming and push notification channels", () => {
    expect(A2A_NOTIFICATIONS.taskEvent).toBe("a2a.task.event");
    expect(A2A_NOTIFICATIONS.push).toBe("a2a.push");
  });

  it("exposes stable broker error codes", () => {
    expect(A2A_ERROR_CODES.unknownToken).toBe("A2A_UNKNOWN_TOKEN");
    expect(A2A_ERROR_CODES.crossContextDenied).toBe("A2A_CROSS_CONTEXT_DENIED");
    expect(A2A_ERROR_CODES.invalidTransition).toBe("A2A_INVALID_TRANSITION");
  });
});
