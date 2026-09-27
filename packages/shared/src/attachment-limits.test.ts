import { describe, expect, it } from "vitest";
import { MAX_INLINE_IMAGE_BYTES } from "./attachment-limits.js";

describe("attachment transport limits", () => {
  it("keeps inline images within MiniMax's 10 MB request limit", () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(10_000_000);
  });
});
