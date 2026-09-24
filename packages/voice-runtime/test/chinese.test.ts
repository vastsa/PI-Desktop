import { describe, it, expect } from "vitest";
import { isChineseLanguage } from "../src/chinese.js";

describe("isChineseLanguage", () => {
  it("detects zh as Chinese", () => {
    expect(isChineseLanguage("zh")).toBe(true);
  });

  it("detects zh-CN as Chinese", () => {
    expect(isChineseLanguage("zh-CN")).toBe(true);
  });

  it("detects zh-TW as Chinese", () => {
    expect(isChineseLanguage("zh-TW")).toBe(true);
  });

  it("detects yue as Chinese (Cantonese)", () => {
    expect(isChineseLanguage("yue")).toBe(true);
  });

  it("rejects en", () => {
    expect(isChineseLanguage("en")).toBe(false);
  });

  it("rejects ja", () => {
    expect(isChineseLanguage("ja")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isChineseLanguage("ZH")).toBe(true);
    expect(isChineseLanguage("Zh-cn")).toBe(true);
  });
});
