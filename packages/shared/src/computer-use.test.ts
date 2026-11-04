import { expect, it } from "vitest";
import {
  COMPUTER_ACTION_BUDGET_LIMIT,
  COMPUTER_MAX_STEPS_LIMIT,
  validateComputerToolArgs,
  validateComputerUseSettings,
} from "./computer-use.js";

it("computerUse settings accept the minimum shape", () => {
  expect(validateComputerUseSettings({ enabled: false })).toEqual({ enabled: false });
});

it("computerUse settings keep an explicit model binding", () => {
  const value = validateComputerUseSettings({
    enabled: true,
    model: { providerId: "p1", modelId: "ui-model" },
    defaultInputPolicy: "autonomous-in-scope",
    defaultCapture: "a11y-and-pixels",
    denylist: ["com.apple.keychainaccess"],
    actionBudget: 10,
    idleExpiryMs: 60_000,
  });
  expect(value.model).toEqual({ providerId: "p1", modelId: "ui-model" });
  expect(value.defaultInputPolicy).toBe("autonomous-in-scope");
  expect(value.defaultCapture).toBe("a11y-and-pixels");
  expect(value.denylist).toEqual(["com.apple.keychainaccess"]);
});

it("computerUse settings distinguish an absent binding from a cleared one", () => {
  expect(validateComputerUseSettings({ enabled: true }).model).toBe(undefined);
  expect(validateComputerUseSettings({ enabled: true, model: null }).model).toBe(null);
});

it("computerUse settings reject unknown keys and bad values", () => {
  for (const value of [
    { enabled: true, somethingElse: 1 },
    { enabled: "yes" },
    { enabled: true, model: { providerId: "p1" } },
    { enabled: true, model: { providerId: "p1", modelId: "m", extra: 1 } },
    { enabled: true, model: { providerId: " p1", modelId: "m" } },
    { enabled: true, defaultInputPolicy: "whatever" },
    { enabled: true, defaultCapture: "pixels" },
    { enabled: true, denylist: "com.apple" },
    { enabled: true, actionBudget: 0 },
    { enabled: true, actionBudget: COMPUTER_ACTION_BUDGET_LIMIT + 1 },
    { enabled: true, actionBudget: 1.5 },
    { enabled: true, idleExpiryMs: 1_000 },
    [],
    null,
    "enabled",
  ]) {
    expect(() => validateComputerUseSettings(value), `accepted ${JSON.stringify(value)}`).toThrow(/invalid/);
  }
});

it("Computer tool args require an instruction and nothing else", () => {
  expect(validateComputerToolArgs({ instruction: "  open preferences  " })).toEqual({
    instruction: "open preferences",
  });
  expect(
    validateComputerToolArgs({ instruction: "read it", observeOnly: true, maxSteps: 3 }),
  ).toEqual({ instruction: "read it", maxSteps: 3, observeOnly: true });
});

it("Computer tool args refuse addressing, targets, and runaway step counts", () => {
  for (const value of [
    { instruction: "" },
    { instruction: "   " },
    { instruction: "x".repeat(4_001) },
    { instruction: "click it", uid: "node-3" },
    { instruction: "click it", point: { x: 1, y: 2 } },
    { instruction: "click it", targetId: "window-9" },
    { instruction: "click it", maxSteps: 0 },
    { instruction: "click it", maxSteps: COMPUTER_MAX_STEPS_LIMIT + 1 },
    { instruction: "click it", observeOnly: "yes" },
    "open preferences",
    null,
  ]) {
    expect(() => validateComputerToolArgs(value), `accepted ${JSON.stringify(value)}`).toThrow(/Computer/);
  }
});
