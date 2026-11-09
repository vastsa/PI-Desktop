import { describe, expect, it } from "vitest";
import type { ModeDefinition, ModeTurnContext } from "@pi-desktop/shared";
import { builtinModeDefinition } from "../mode-definitions.js";
import {
  parseModeDefinitionParam,
  parseModeLaunchParams,
  parseModeParam,
  parseModePromptTurn,
} from "./mode-params.js";

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

function rejection(run: () => unknown): { errorCode?: string; rpcCode?: number; message: string } {
  try {
    run();
  } catch (error) {
    return error as { errorCode?: string; rpcCode?: number; message: string };
  }
  throw new Error("expected a rejection");
}

describe("sidecar mode parameters", () => {
  it("accepts any valid mode id and keeps the legacy defaults", () => {
    expect(parseModeParam(undefined)).toBe("agent");
    expect(parseModeParam("chat")).toBe("plan");
    expect(parseModeParam("goal")).toBe("goal");
    expect(parseModeParam("reviewer")).toBe("reviewer");
  });

  it("rejects a mode that is not a mode id instead of granting Agent", () => {
    for (const value of ["Agent", "../etc", 7, { id: "agent" }]) {
      expect(rejection(() => parseModeParam(value))).toMatchObject({ errorCode: "MODE_INVALID", rpcCode: -32602 });
    }
  });

  it("accepts the definition of the session mode only", () => {
    expect(parseModeDefinitionParam(goal(), "goal")).toEqual(goal());
    expect(parseModeDefinitionParam(undefined, "goal")).toBeUndefined();
    expect(rejection(() => parseModeDefinitionParam(goal(), "reviewer"))).toMatchObject({
      errorCode: "MODE_DEFINITION_INVALID",
    });
    expect(rejection(() => parseModeDefinitionParam({ ...goal(), permission: "root" }, "goal")).message)
      .toContain("permission");
    expect(rejection(() => parseModeDefinitionParam({ ...goal(), extra: true }, "goal")).message)
      .toContain("expected a mode definition object");
  });

  it("accepts an exact run turn for a declared stage", () => {
    const launch = parseModeLaunchParams({ mode: "goal", modeDefinition: goal() });
    expect(parseModePromptTurn(TURN, launch)).toEqual(TURN);
    expect(parseModePromptTurn(undefined, launch)).toBeUndefined();
  });

  it.each([
    ["an extra key", { ...TURN, permission: "agent" }],
    ["a missing key", { runId: TURN.runId, stageId: TURN.stageId, origin: TURN.origin, enteredStage: false, input: "" }],
    ["an unknown origin", { ...TURN, origin: "plugin" }],
    ["a non-boolean enteredStage", { ...TURN, enteredStage: "yes" }],
    ["an empty run id", { ...TURN, runId: " " }],
    ["an invalid artifact path map", { ...TURN, artifactPaths: { goal: 3 } }],
    ["an undeclared stage", { ...TURN, stageId: "deploy" }],
  ])("rejects a run turn with %s", (_name, value) => {
    const launch = parseModeLaunchParams({ mode: "goal", modeDefinition: goal() });
    expect(rejection(() => parseModePromptTurn(value, launch))).toMatchObject({ errorCode: "MODE_TURN_INVALID" });
  });

  it("rejects a run turn without the staged definition it runs", () => {
    expect(rejection(() => parseModePromptTurn(TURN, parseModeLaunchParams({ mode: "goal" })))).toMatchObject({
      errorCode: "MODE_TURN_INVALID",
    });
    const simple = builtinModeDefinition("plan");
    expect(rejection(() => parseModePromptTurn(TURN, parseModeLaunchParams({ mode: "plan", modeDefinition: simple }))))
      .toMatchObject({ errorCode: "MODE_TURN_INVALID" });
  });
});
