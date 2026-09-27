import { describe, expect, it } from "vitest";
import { formatTimingLine, timingEnabled, TIMING_PREFIX } from "./timing.js";

describe("timing lines", () => {
  it("renders one greppable line and drops absent fields", () => {
    const line = formatTimingLine("tool", {
      tool: "Bash",
      toolCallId: "tc-1",
      hostRttMs: 11842.6,
      errorCode: undefined,
      ok: true,
    });

    expect(line).toBe(
      `${TIMING_PREFIX} kind=tool tool=Bash toolCallId=tc-1 hostRttMs=11843 ok=true`,
    );
    expect(line).not.toContain("errorCode");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("is on by default and opt-out by env", () => {
    expect(timingEnabled({})).toBe(true);
    expect(timingEnabled({ PI_DESKTOP_TIMING: "1" })).toBe(true);
    for (const off of ["0", "off", "false"]) {
      expect(timingEnabled({ PI_DESKTOP_TIMING: off })).toBe(false);
    }
  });
});
