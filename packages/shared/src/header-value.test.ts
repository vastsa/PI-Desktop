import { describe, expect, it } from "vitest";
import { firstHeaderValueFault, foldFullwidthHeaderValue, inspectHeaderValue } from "./header-value.js";

describe("foldFullwidthHeaderValue", () => {
  it("folds the fullwidth block onto ASCII", () => {
    // The reported failure shape: `０` is U+FF10, which lands on index 7 of
    // `1234567０` and made undici throw a ByteString TypeError.
    expect(foldFullwidthHeaderValue("1234567\uFF10")).toBe("12345670");
    expect(foldFullwidthHeaderValue("\uFF10\uFF11\uFF41\uFF0D")).toBe("01a-");
    expect(foldFullwidthHeaderValue("\uFF08\uFF09\uFF0C")).toBe("(),");
  });

  it("folds the ideographic space but keeps interior ASCII text", () => {
    expect(foldFullwidthHeaderValue("PI\u3000Desktop")).toBe("PI Desktop");
  });

  it("leaves halfwidth katakana alone", () => {
    // NFKC would turn these into U+30A2 / U+3099 — still unusable.
    expect(foldFullwidthHeaderValue("\uFF71\uFF9E")).toBe("\uFF71\uFF9E");
  });

  it("keeps characters that have no ASCII counterpart", () => {
    expect(foldFullwidthHeaderValue("星\u201C")).toBe("星\u201C");
  });

  it("returns the input when nothing folds", () => {
    const value = "Bearer sk-abc";
    expect(foldFullwidthHeaderValue(value)).toBe(value);
  });
});

describe("firstHeaderValueFault", () => {
  it("accepts printable ASCII, HTAB, and Latin-1", () => {
    expect(firstHeaderValueFault("")).toBeNull();
    expect(firstHeaderValueFault("pi-desktop/0.15.3")).toBeNull();
    expect(firstHeaderValueFault("a\tb")).toBeNull();
    expect(firstHeaderValueFault("caf\u00E9")).toBeNull();
  });

  it("names the first unusable character and where it sits", () => {
    expect(firstHeaderValueFault("0123456\uFF10")).toEqual({
      index: 7,
      codePoint: 0xff10,
    });
    expect(firstHeaderValueFault("abc星")).toEqual({ index: 3, codePoint: 0x661f });
    expect(firstHeaderValueFault("ab\u0000cd")).toEqual({ index: 2, codePoint: 0 });
    expect(firstHeaderValueFault("a\r\nb")).toEqual({ index: 1, codePoint: 0x0d });
    expect(firstHeaderValueFault("trailing\u007F")).toEqual({
      index: 8,
      codePoint: 0x7f,
    });
  });
});

describe("inspectHeaderValue", () => {
  it("reports the folded value a request should carry", () => {
    expect(inspectHeaderValue("  \uFF10  7星  ")).toEqual({
      value: "0  7星",
      folded: true,
      fault: { index: 4, codePoint: 0x661f },
    });
  });

  it("folds a half-width-style header preset", () => {
    expect(inspectHeaderValue("  X-Title: \uFF10  ")).toEqual({
      value: "X-Title: 0",
      folded: true,
      fault: null,
    });
  });

  it("marks an untouched value as not folded", () => {
    expect(inspectHeaderValue("  pi-desktop  ")).toEqual({
      value: "pi-desktop",
      folded: false,
      fault: null,
    });
  });

  it("reports the folded value's fault, not the raw input's", () => {
    // U+FF10 folds to `0`, so the remaining fault is the Han character.
    expect(inspectHeaderValue("\uFF10星")).toEqual({
      value: "0星",
      folded: true,
      fault: { index: 1, codePoint: 0x661f },
    });
  });
});

describe("trim", () => {
  it("strips a pasted byte-order mark, as the host does", () => {
    // U+FEFF is invisible and arrives with values copied from UTF-8 files.
    // Both engines must drop it: otherwise the editor would show a clean value
    // while the host refuses it as a non-Latin-1 character.
    expect(inspectHeaderValue("\uFEFFX-Title\uFEFF")).toEqual({
      value: "X-Title",
      folded: false,
      fault: null,
    });
  });

  it("keeps U+0085, which JavaScript does not treat as whitespace", () => {
    // It travels: the Latin-1 supplement is allowed in a header value, so the
    // host has to store the same bytes the runtime would have sent.
    expect(inspectHeaderValue("\u0085abc\u0085")).toEqual({
      value: "\u0085abc\u0085",
      folded: false,
      fault: null,
    });
  });
});
