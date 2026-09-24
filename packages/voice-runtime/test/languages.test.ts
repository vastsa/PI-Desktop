import { describe, it, expect } from "vitest";
import { SUPPORTED_LANGUAGES, languageLabel } from "../src/languages.js";

describe("SUPPORTED_LANGUAGES", () => {
  it("contains at least Chinese and English", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toContain("zh");
    expect(codes).toContain("en");
  });
});

describe("languageLabel", () => {
  it("returns label for known code", () => {
    expect(languageLabel("zh")).toBe("Chinese (Mandarin)");
    expect(languageLabel("en")).toBe("English");
  });

  it("returns code itself for unknown language", () => {
    expect(languageLabel("xx")).toBe("xx");
  });
});
