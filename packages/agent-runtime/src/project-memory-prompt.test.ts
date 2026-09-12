import { describe, expect, it } from "vitest";
import { projectMemoryPrompt } from "./project-memory-prompt.js";

describe("projectMemoryPrompt", () => {
  it("omits blank memory and trims saved content", () => {
    expect(projectMemoryPrompt("  \n\t")).toBeUndefined();
    expect(projectMemoryPrompt("  Keep the API stable.  ")).toContain(
      "Keep the API stable.",
    );
  });

  it("marks memory as user-provided context", () => {
    const prompt = projectMemoryPrompt("Use the staging database.");
    expect(prompt).toContain("# Project memory");
    expect(prompt).toContain("user-provided context");
    expect(prompt).toContain("Use the staging database.");
  });
});
