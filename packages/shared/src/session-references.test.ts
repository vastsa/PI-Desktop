import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_REFERENCE_BUDGET_PERCENT,
  DEFAULT_SESSION_REFERENCE_MAX_TURNS,
  SESSION_REFERENCE_BUDGET_PERCENTS,
  SESSION_REFERENCE_MAX_TURNS_CHOICES,
  resolveSessionReferenceBudgetPercent,
  resolveSessionReferenceMaxTurns,
  resolveSessionReferenceSettings,
} from "./session-references.js";

describe("session reference settings", () => {
  it("offers 10/25/50/100 % (default 25) and 3/5/10/20 turns (default 10)", () => {
    expect(SESSION_REFERENCE_BUDGET_PERCENTS).toEqual([10, 25, 50, 100]);
    expect(DEFAULT_SESSION_REFERENCE_BUDGET_PERCENT).toBe(25);
    expect(SESSION_REFERENCE_MAX_TURNS_CHOICES).toEqual([3, 5, 10, 20]);
    expect(DEFAULT_SESSION_REFERENCE_MAX_TURNS).toBe(10);
  });

  it("keeps the offered values", () => {
    for (const value of SESSION_REFERENCE_BUDGET_PERCENTS) {
      expect(resolveSessionReferenceBudgetPercent(value)).toBe(value);
    }
    for (const value of SESSION_REFERENCE_MAX_TURNS_CHOICES) {
      expect(resolveSessionReferenceMaxTurns(value)).toBe(value);
    }
  });

  it("reads absent and unrecognised values as the defaults", () => {
    for (const value of [undefined, null, 0, 30, "25", 25.5, Number.NaN, {}]) {
      expect(resolveSessionReferenceBudgetPercent(value)).toBe(25);
      expect(resolveSessionReferenceMaxTurns(value)).toBe(10);
    }
    expect(resolveSessionReferenceSettings(undefined)).toEqual({ budgetPercent: 25, maxTurns: 10 });
    expect(resolveSessionReferenceSettings({})).toEqual({ budgetPercent: 25, maxTurns: 10 });
    expect(
      resolveSessionReferenceSettings({
        sessionReferenceBudgetPercent: 50,
        sessionReferenceMaxTurns: 3,
      }),
    ).toEqual({ budgetPercent: 50, maxTurns: 3 });
  });
});
