import { describe, expect, it } from "vitest";
import {
  SKILL_CATALOG_BUDGET_CHARS,
  skillCatalogBudget,
  skillCatalogChars,
} from "./skill-catalog-budget.js";

const entry = (name: string, description = "") => ({ name, description });

describe("skillCatalogChars", () => {
  it("counts name, description and the separator", () => {
    // 4 + 6 + 6 = 16: the separator is part of what the prompt pays.
    expect(skillCatalogChars([entry("abcd", "123456")])).toBe(16);
  });

  it("treats a missing description as empty rather than an error", () => {
    expect(skillCatalogChars([{ name: "abcd" }])).toBe(10);
    expect(skillCatalogChars([entry("abcd", "")])).toBe(10);
  });

  it("is zero for an empty library", () => {
    expect(skillCatalogChars([])).toBe(0);
  });
});

describe("skillCatalogBudget", () => {
  it("matches the measured cost of a real entry", () => {
    // ~123 chars per entry is the figure the budget was chosen against.
    const library = [
      entry("add-npm-script", "Use when asked to add an npm script to a package."),
      entry("loadbox-log-triage", "Use when a loadbox run fails and the log is the only evidence."),
    ];
    const budget = skillCatalogBudget(library);
    expect(budget.skills).toBe(2);
    expect(budget.chars / budget.skills).toBeGreaterThan(70);
    expect(budget.chars / budget.skills).toBeLessThan(180);
    expect(budget.over).toBe(false);
  });

  it("goes over at the size where the cost stops being free", () => {
    // 200 entries is where the measured cost reaches ~7k tokens per turn.
    const library = Array.from({ length: 200 }, (_, index) =>
      entry(`skill-${index}`, "x".repeat(80)),
    );
    const budget = skillCatalogBudget(library);
    expect(budget.over).toBe(true);
    expect(budget.chars).toBeGreaterThan(SKILL_CATALOG_BUDGET_CHARS);
  });

  it("does not go over just below the limit", () => {
    const library = [entry("a", "x".repeat(SKILL_CATALOG_BUDGET_CHARS - 10))];
    expect(skillCatalogBudget(library).over).toBe(false);
  });

  it("accepts an explicit limit so a caller can preview a tighter budget", () => {
    const budget = skillCatalogBudget([entry("abcd", "123456")], 15);
    expect(budget).toEqual({ chars: 16, limit: 15, skills: 1, over: true });
  });
});
