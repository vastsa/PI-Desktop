import { describe, expect, it } from "vitest";
import type { ComputerAction, ComputerCursorEvent, ComputerGrantView, ComputerNode } from "@pi-desktop/shared";

import { runComputerLoop, type ComputerLoopDeps } from "./loop.js";
import type { Observation } from "./prompt.js";

function grant(overrides: Partial<ComputerGrantView> = {}): ComputerGrantView {
  return {
    grantId: "cug_1",
    revision: 3,
    scope: "desktop",
    targetId: "77:12",
    targetLabel: "Example — Document",
    appKey: "example",
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    inputPolicy: "autonomous-in-scope",
    capture: "a11y-only",
    remainingBudget: 10,
    sessionId: "session-1",
    createdAt: "2026-11-04T00:00:00.000Z",
    expiresAt: "2026-11-04T00:15:00.000Z",
    state: "active",
    ...overrides,
  };
}

const saveButton: ComputerNode = {
  uid: "0.1#ab",
  role: "AXButton",
  label: "Save",
  hasValue: false,
  enabled: true,
  focused: false,
  bounds: { x: 150, y: 200, width: 80, height: 24 },
  actions: ["click"],
};

function observation(nodes: ComputerNode[] = [saveButton], overrides: Partial<Observation> = {}): Observation {
  return {
    grant: grant(),
    inspection: {
      grantId: "cug_1",
      revision: 3,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      fidelity: "full",
      nodes,
      truncated: false,
      secureInput: false,
    },
    ...overrides,
  };
}

type Harness = {
  deps: ComputerLoopDeps;
  acted: ComputerAction[];
  cursor: ComputerCursorEvent[];
  decisions: number;
};

function harness(answers: string[], options: { act?: () => void; observe?: () => Observation } = {}): Harness {
  const acted: ComputerAction[] = [];
  const cursor: ComputerCursorEvent[] = [];
  const state = { decisions: 0 };
  const deps: ComputerLoopDeps = {
    observe: async () => (options.observe ? options.observe() : observation()),
    act: async (action) => {
      options.act?.();
      acted.push(action);
      return { grantId: "cug_1", revision: 3, remainingBudget: 9, dispatched: "accessibility-action" };
    },
    decide: async () => {
      const answer = answers[Math.min(state.decisions, answers.length - 1)];
      state.decisions += 1;
      return answer;
    },
    onCursor: (event) => cursor.push(event),
  };
  return {
    deps,
    acted,
    cursor,
    get decisions() {
      return state.decisions;
    },
  };
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("runComputerLoop", () => {
  it("acts once and stops on done", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"saved"}',
    ]);
    const result = await runComputerLoop({ instruction: "save the document" }, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.acted).toEqual([{ kind: "click", uid: "0.1#ab" }]);
    expect(result.steps.filter((step) => step.ok && step.action === "click")).toHaveLength(1);
    // The model's claim is labelled, never presented as the loop's own report.
    expect(result.summary).toContain("Model's account: saved");
    expect(result.summary).toContain("Dispatched 1 of 1 action");
  });

  it("observeOnly describes the scope and dispatches nothing", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}']);
    const result = await runComputerLoop({ instruction: "what is on screen", observeOnly: true }, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.acted).toEqual([]);
    expect(h.decisions).toBe(0, "observe-only never asks the model to act");
    expect(result.summary).toContain("1 accessible element");
  });

  it("stops at the step limit without claiming success", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}']);
    const result = await runComputerLoop({ instruction: "click forever", maxSteps: 3 }, h.deps);
    expect(result.outcome).toBe("step-limit");
    expect(h.acted).toHaveLength(3);
    expect(result.summary).toContain("may be unfinished");
  });

  it("gives up after repeated unusable answers", async () => {
    const h = harness(["I clicked Save for you."]);
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("COMPUTER_ACTION_REJECTED");
    expect(h.acted).toEqual([]);
  });

  it("surfaces a question instead of guessing", async () => {
    const h = harness(['{"kind":"ask","question":"which document?"}']);
    const result = await runComputerLoop({ instruction: "save it" }, h.deps);
    expect(result.outcome).toBe("needs-user");
    expect(result.question).toBe("which document?");
    expect(h.acted).toEqual([]);
  });

  it("treats a revoked grant as terminal and stops immediately", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_GRANT_EXPIRED");
      },
    });
    const result = await runComputerLoop({ instruction: "save", maxSteps: 5 }, h.deps);
    expect(result.outcome).toBe("expired");
    expect(result.errorCode).toBe("COMPUTER_GRANT_EXPIRED");
    expect(h.decisions).toBe(1, "a terminal refusal is not retried");
  });

  it("reports a budget refusal as its own outcome", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_BUDGET_EXHAUSTED");
      },
    });
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(result.outcome).toBe("budget-exhausted");
  });

  it("stops when the same non-terminal refusal repeats", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_ELEMENT_NOT_ACTIONABLE");
      },
    });
    const result = await runComputerLoop({ instruction: "save", maxSteps: 8 }, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.steps.filter((step) => !step.ok)).toHaveLength(2);
  });

  it("refuses an invented uid without reaching the host", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"9.9#ff"}}',
      '{"kind":"done","summary":"gave up"}',
    ]);
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(h.acted).toEqual([]);
    expect(result.steps[0]).toMatchObject({ ok: false, errorCode: "COMPUTER_ACTION_REJECTED" });
  });

  it("fails closed when the first observation is refused", async () => {
    const deps: ComputerLoopDeps = {
      observe: async () => {
        throw coded("COMPUTER_SECURE_INPUT_REFUSED");
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => '{"kind":"done","summary":"x"}',
    };
    const result = await runComputerLoop({ instruction: "save" }, deps);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("COMPUTER_SECURE_INPUT_REFUSED");
  });

  it("draws the cursor around each action and hides it at the end", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"saved"}',
    ]);
    await runComputerLoop({ instruction: "save" }, h.deps);
    const kinds = h.cursor.map((event) => event.kind);
    expect(kinds[0]).toBe("show");
    expect(kinds).toContain("move");
    expect(kinds).toContain("press");
    expect(kinds[kinds.length - 1]).toBe("hide");
    const move = h.cursor.find((event) => event.kind === "move");
    // The drawn point is the element's centre, in screen coordinates.
    expect(move).toMatchObject({ x: 190, y: 212 });
  });

  it("switches to another window without spending an action", async () => {
    const asked: (string | undefined)[] = [];
    const cursor: ComputerCursorEvent[] = [];
    const answers = ['{"kind":"switch","window":"88:4","note":"the task is over there"}', '{"kind":"done","summary":"read it"}'];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        asked.push(targetId);
        return observation([saveButton], {
          grant: grant(
            targetId
              ? { targetId, targetLabel: "Other — Inbox", revision: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }
              : {},
          ),
          windows: [
            { targetId: "77:12", appName: "Example", title: "Document", appKey: "example", bounds: grant().bounds },
            { targetId: "88:4", appName: "Other", title: "Inbox", appKey: "other", bounds: grant().bounds },
          ],
        });
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
      onCursor: (event) => cursor.push(event),
    };
    const result = await runComputerLoop({ instruction: "read the inbox" }, deps);
    expect(result.outcome).toBe("done");
    expect(asked).toEqual([undefined, "88:4"]);
    expect(result.steps[0]).toMatchObject({ action: "switch", ok: true, target: "Other — Inbox" });
    // A switch is a read: it must not read as work done on the machine.
    expect(result.summary).toContain("No action was dispatched.");
    // The overlay follows the window being worked on.
    expect(cursor.filter((event) => event.kind === "show")).toHaveLength(2);
  });

  it("reports a refused window and keeps the remaining steps", async () => {
    const answers = ['{"kind":"switch","window":"self"}', '{"kind":"done","summary":"left it alone"}'];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        if (targetId) throw coded("COMPUTER_SELF_TARGET_REFUSED");
        return observation();
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
    };
    const result = await runComputerLoop({ instruction: "click PI-Desktop's own approve button" }, deps);
    // The refusal is the model's problem to work around, not a failed run.
    expect(result.outcome).toBe("done");
    expect(result.steps[0]).toMatchObject({
      action: "switch",
      ok: false,
      errorCode: "COMPUTER_SELF_TARGET_REFUSED",
    });
  });

  it("stops when the grant dies during a switch", async () => {
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        if (targetId) throw coded("COMPUTER_GRANT_EXPIRED");
        return observation();
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => '{"kind":"switch","window":"88:4"}',
    };
    const result = await runComputerLoop({ instruction: "look at the other window", maxSteps: 5 }, deps);
    expect(result.outcome).toBe("expired");
    expect(result.errorCode).toBe("COMPUTER_GRANT_EXPIRED");
  });

  it("hides the cursor even when the loop throws", async () => {
    const cursor: ComputerCursorEvent[] = [];
    const deps: ComputerLoopDeps = {
      observe: async () => observation(),
      act: async () => {
        throw new Error("boom");
      },
      decide: async () => {
        throw new Error("provider exploded");
      },
      onCursor: (event) => cursor.push(event),
    };
    const result = await runComputerLoop({ instruction: "save" }, deps);
    expect(result.outcome).toBe("failed");
    expect(cursor[cursor.length - 1]?.kind).toBe("hide");
  });
});
