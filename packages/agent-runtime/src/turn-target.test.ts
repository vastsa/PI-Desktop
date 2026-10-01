import { describe, expect, it } from "vitest";
import { matchesExpectedTurnId } from "./turn-target.js";

describe("matchesExpectedTurnId", () => {
  it("allows legacy calls without a frozen turn and an exact current target", () => {
    expect(matchesExpectedTurnId("turn-a", undefined)).toBe(true);
    expect(matchesExpectedTurnId("turn-a", "")).toBe(true);
    expect(matchesExpectedTurnId("turn-a", "turn-a")).toBe(true);
  });

  it("rejects missing or replaced active turns when an exact target was supplied", () => {
    expect(matchesExpectedTurnId(undefined, "turn-a")).toBe(false);
    expect(matchesExpectedTurnId("turn-b", "turn-a")).toBe(false);
  });
});
