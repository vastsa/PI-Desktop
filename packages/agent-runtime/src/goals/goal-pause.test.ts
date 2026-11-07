import { expect, it } from "vitest";
import { GoalPauseCloseout } from "./goal-pause.js";

it("a paused closeout rejects a fourth request even if recovery bypasses normal finishTurn", () => {
  const policy = new GoalPauseCloseout();
  expect(policy.request()).toBe(true); expect(policy.request()).toBe(false);
  for (let index = 0; index < 3; index++) policy.modelRequest();
  expect(policy.exhausted).toBe(true);
  expect(() => policy.modelRequest()).toThrow("closeout request limit");
});

it("normal execution is not capped and closing tools exclude work and long waits", () => {
  const policy = new GoalPauseCloseout();
  for (let index = 0; index < 10; index++) policy.modelRequest();
  expect(policy.exhausted).toBe(false); expect(policy.allowsTool("Write")).toBe(true);
  policy.request(); expect(policy.allowsTool("Write")).toBe(false);
  expect(policy.allowsTool("TaskWait")).toBe(false); expect(policy.allowsTool("TaskStop")).toBe(true);
});
