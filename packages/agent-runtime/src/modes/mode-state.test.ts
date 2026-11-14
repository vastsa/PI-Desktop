import { describe, expect, it } from "vitest";
import type { ModeDefinition, ModeTurnContext } from "@pi-desktop/shared";
import { builtinModeDefinition } from "../mode-definitions.js";
import { MODE_CLOSEOUT_MAX_REQUESTS, MODE_CLOSEOUT_PROMPT, MODE_INPUT_EDITED_PROMPT, RuntimeModeState } from "./mode-state.js";
import { parseModeTurnNotice } from "./mode-params.js";

function goal(): ModeDefinition {
  const definition = builtinModeDefinition("goal");
  if (!definition) throw new Error("builtin goal definition missing");
  return definition;
}

const TURN: ModeTurnContext = {
  runId: "run-1",
  stageId: "work",
  origin: "host",
  enteredStage: false,
  input: "Make checkout work",
  artifactPaths: { goal: ".pi/goals/run-1.md" },
};

const missing = async () => ({ status: "missing" as const });

async function runningGoal(): Promise<RuntimeModeState> {
  const state = new RuntimeModeState("goal", goal());
  await state.beginTurn(TURN, missing);
  return state;
}

describe("paused run closeout", () => {
  it("adds the closeout notice and ends after the allowed model requests", async () => {
    const state = await runningGoal();
    expect(state.instructions()).not.toContain(MODE_CLOSEOUT_PROMPT);

    expect(state.beginCloseout("run-1")).toBe(true);
    expect(state.beginCloseout("run-1")).toBe(false);
    expect(state.instructions()).toContain("# Run paused");
    // The request in flight when Pause arrived is not counted.
    expect(state.closeoutExhausted()).toBe(false);
    for (let request = 1; request < MODE_CLOSEOUT_MAX_REQUESTS; request += 1) {
      state.noteModelRequest();
      expect(state.closeoutExhausted()).toBe(false);
    }
    state.noteModelRequest();
    expect(state.closeoutExhausted()).toBe(true);
  });

  it("applies only to the run this turn works on, and not after the turn", async () => {
    const state = await runningGoal();
    expect(state.beginCloseout("run-other")).toBe(false);
    state.endTurn();
    expect(state.beginCloseout("run-1")).toBe(false);
    expect(new RuntimeModeState("agent").beginCloseout("run-1")).toBe(false);
  });

  it("counts nothing without a closeout and resets on the next turn", async () => {
    const state = await runningGoal();
    for (let request = 0; request < 10; request += 1) state.noteModelRequest();
    expect(state.closeoutExhausted()).toBe(false);

    state.beginCloseout("run-1");
    for (let request = 0; request < MODE_CLOSEOUT_MAX_REQUESTS; request += 1) state.noteModelRequest();
    expect(state.closeoutExhausted()).toBe(true);
    // A resumed run starts a fresh turn: no notice, no limit.
    await state.beginTurn({ ...TURN, origin: "approval" }, missing);
    expect(state.closingOut).toBe(false);
    expect(state.closeoutExhausted()).toBe(false);
    expect(state.instructions()).not.toContain("# Run paused");
  });

  it("drops the run context when the session leaves the mode", async () => {
    const state = await runningGoal();
    state.beginCloseout("run-1");
    expect(state.setMode("agent")).toBe(true);
    expect(state.modeTurn).toBeUndefined();
    expect(state.closingOut).toBe(false);
  });
});

describe("edited run input", () => {
  it("flags the first turn after the input changed, once", async () => {
    const state = await runningGoal();
    expect(state.instructions()).not.toContain(MODE_INPUT_EDITED_PROMPT);
    state.endTurn();
    await state.beginTurn({ ...TURN, input: "Make checkout and refunds work" }, missing);
    expect(state.instructions()).toContain("# Objective edited");
    expect(state.instructions()).toContain("Make checkout and refunds work");
    state.endTurn();
    await state.beginTurn({ ...TURN, input: "Make checkout and refunds work" }, missing);
    expect(state.instructions()).not.toContain("# Objective edited");
  });

  it("does not flag a new run or a turn without a run", async () => {
    const state = await runningGoal();
    state.endTurn();
    await state.beginTurn({ ...TURN, runId: "run-2", input: "Something else" }, missing);
    expect(state.instructions()).not.toContain("# Objective edited");
    await state.beginTurn(undefined, missing);
    expect(state.instructions()).not.toContain("# Objective edited");
  });
});

describe("mode turn notices", () => {
  it("parses closeout and release with exact fields", () => {
    expect(parseModeTurnNotice({ turnId: "t", runId: "r", action: "closeout" })).toEqual({ turnId: "t", runId: "r", action: "closeout" });
    expect(parseModeTurnNotice({ turnId: "t", runId: "r", action: "release", mode: "agent" })).toEqual({
      turnId: "t",
      runId: "r",
      action: "release",
      mode: "agent",
    });
    for (const bad of [
      { turnId: "", runId: "r", action: "closeout" },
      { turnId: "t", runId: 3, action: "closeout" },
      { turnId: "t", runId: "r", action: "stop" },
    ]) {
      expect(() => parseModeTurnNotice(bad)).toThrow();
    }
  });
});

it("adds blocked reporting to an existing immutable Goal snapshot without changing its objective or gates", async () => {
  const snapshot = goal();
  snapshot.prompt = "Legacy Goal instructions: complete only after verification.";
  const before = JSON.stringify(snapshot);
  const state = new RuntimeModeState("goal", snapshot);
  await state.beginTurn(TURN, missing);
  expect(state.instructions()).toContain("report.status: blocked");
  expect(state.instructions()).toContain("not successful completion");
  expect(state.instructions()).toContain(TURN.input);
  expect(JSON.stringify(snapshot)).toBe(before);
});
