import { describe, expect, it } from "vitest";
import { ErrorCodes, err, ok } from "./errors.js";

describe("result helpers", () => {
  it("creates ok results", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
  });

  it("creates error results", () => {
    const result = err("NOT_FOUND", "missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("exposes approved-plan execution failure codes", () => {
    expect(ErrorCodes.PLAN_ARTIFACT_INVALID).toBe("PLAN_ARTIFACT_INVALID");
    expect(ErrorCodes.PLAN_EXECUTION_INTERRUPTED).toBe(
      "PLAN_EXECUTION_INTERRUPTED",
    );
    expect(ErrorCodes.PLAN_REQUIRES_INTERACTIVE_SESSION).toBe(
      "PLAN_REQUIRES_INTERACTIVE_SESSION",
    );
    expect(ErrorCodes.TOOL_ABORTED).toBe("TOOL_ABORTED");
  });

  it("exposes command shell contract failure codes", () => {
    expect(ErrorCodes.COMMAND_SHELL_CHANGED).toBe("COMMAND_SHELL_CHANGED");
    expect(ErrorCodes.SHELL_NOT_FOUND).toBe("SHELL_NOT_FOUND");
    expect(ErrorCodes.COMMAND_SHELL_INVALID).toBe("COMMAND_SHELL_INVALID");
  });

  it("registers newly emitted runtime and Edit error codes", () => {
    const newlyLiveCodes = [
      "CONTEXT_COMPACTION_FAILED",
      "EMPTY_MODEL_RESPONSE",
      "EDIT_TAG_REQUIRED",
      "EDIT_TAG_MISMATCH",
      "EDIT_TAG_UNKNOWN",
      "EDIT_LINES_UNSEEN",
      "EDIT_PARSE_FAILED",
      "EDIT_RANGE_INVALID",
      "EDIT_BLOCK_UNRESOLVED",
      "EDIT_REGISTER_EMPTY",
      "EDIT_REGISTER_AMBIGUOUS",
      "EDIT_REPAIR_AMBIGUOUS",
      "EDIT_NO_CHANGE",
      "EDIT_AMPLIFICATION_LIMIT",
      "MODEL_ALIAS_TOO_LONG",
    ] as const;

    for (const code of newlyLiveCodes) {
      expect(ErrorCodes[code]).toBe(code);
    }
  });
});
