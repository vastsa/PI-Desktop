import { describe, expect, it } from "vitest";
import { MAX_HOST_STDIN_LINE_BYTES } from "./rpc-limits.js";

describe("host stdin line cap", () => {
  it("is 64 MiB", () => {
    expect(MAX_HOST_STDIN_LINE_BYTES).toBe(64 * 1024 * 1024);
  });
});
