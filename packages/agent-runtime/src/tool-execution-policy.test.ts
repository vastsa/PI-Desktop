import { describe, expect, it } from "vitest";
import { TOOL_EXECUTION_SPECS, toolExecutionMode } from "./tool-execution-policy.js";

describe("builtin tool execution modes", () => {
  it.each([
    ["Read", "parallel", "parallel"],
    ["Glob", "parallel", "parallel"],
    ["Grep", "parallel", "parallel"],
    ["Edit", "sequential", "parallel"],
    ["Write", "sequential", "parallel"],
    ["Bash", "sequential", "sequential"],
    ["Task", "parallel", "parallel"],
    ["unknown_tool", "sequential", "sequential"],
  ])("%s with and without Host file batches", (name, withoutBatch, withBatch) => {
    expect(Object.hasOwn(TOOL_EXECUTION_SPECS, name)).toBe(name !== "unknown_tool");
    expect(toolExecutionMode(name)).toBe(withoutBatch);
    expect(toolExecutionMode(name, true)).toBe(withBatch);
  });
});
