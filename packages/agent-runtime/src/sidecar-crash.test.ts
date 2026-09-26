import { describe, expect, it } from "vitest";

import { classifySidecarCrash, sidecarCrashErrorCode } from "./sidecar-crash.js";
import { ErrorCodes } from "@pi-desktop/shared";

const OOM_TAIL = [
  "<--- Last few GCs --->",
  "[43001:0x100008b0000]  2435727 ms: Mark-Compact (reduce) 2046.4 (2056.4) -> 2046.4 (2056.4) MB, ... last resort; GC in old space requested",
  "",
  "<--- JS stacktrace --->",
  "",
  "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
].join("\n");

describe("classifySidecarCrash", () => {
  it("classifies a V8 heap-exhaustion tail as oom", () => {
    const crash = classifySidecarCrash(OOM_TAIL);
    expect(crash.kind).toBe("oom");
    expect(crash.marker).toBeTruthy();
    expect(sidecarCrashErrorCode(crash.kind)).toBe("AGENT_SIDECAR_OOM");
  });

  it("recognizes the compact heap-out-of-memory banner without the GC block", () => {
    const crash = classifySidecarCrash(
      "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
    );
    expect(crash.kind).toBe("oom");
    expect(sidecarCrashErrorCode(crash.kind)).toBe("AGENT_SIDECAR_OOM");
  });

  it("an unrecognized native failure stays an honest generic crash", () => {
    for (const tail of [
      "",
      "Segmentation fault",
      "some unrelated warning\nanother line",
    ]) {
      const crash = classifySidecarCrash(tail);
      expect(crash.kind).toBe("crashed");
      expect(crash.marker).toBeUndefined();
      expect(sidecarCrashErrorCode(crash.kind)).toBe("AGENT_SIDECAR_CRASHED");
    }
  });

  it("non-string tails (undefined from an old exit payload) are not oom", () => {
    expect(classifySidecarCrash(undefined).kind).toBe("crashed");
    expect(classifySidecarCrash(null).kind).toBe("crashed");
  });
  it("inspects the real exit payload: the transport hands over string[] lines", () => {
    // `AgentSidecar.notifyExit` passes `this.stderrTail.slice()` — an array of
    // buffered lines, not a joined string. This is the shape the desktop exit
    // path actually receives (PR #1080 review).
    const crash = classifySidecarCrash(OOM_TAIL.split("\n"));
    expect(crash.kind).toBe("oom");
    expect(crash.marker).toBeTruthy();
    expect(sidecarCrashErrorCode(crash.kind)).toBe("AGENT_SIDECAR_OOM");

    const generic = classifySidecarCrash(["Segmentation fault", "core dumped"]);
    expect(generic.kind).toBe("crashed");
  });

  it("filters non-string array entries instead of treating the array as absent", () => {
    const crash = classifySidecarCrash([
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      undefined,
      42,
    ] as unknown[]);
    expect(crash.kind).toBe("oom");
  });

  it("non-array, non-string tails (undefined from an old exit payload) are not oom", () => {
    expect(classifySidecarCrash(undefined).kind).toBe("crashed");
    expect(classifySidecarCrash(null).kind).toBe("crashed");
  });

  it("both classified codes are registered shared error codes", () => {
    expect(ErrorCodes.AGENT_SIDECAR_OOM).toBe("AGENT_SIDECAR_OOM");
    expect(ErrorCodes.AGENT_SIDECAR_CRASHED).toBe("AGENT_SIDECAR_CRASHED");
  });
});
