import { describe, expect, it } from "vitest";
import { sanitizeThemeCss, THEME_CSS_MAX_BYTES } from "./theme-css.js";

function error(css: string): string {
  const result = sanitizeThemeCss(css);
  if (result.ok) throw new Error("expected the css to be rejected");
  return result.error;
}

describe("sanitizeThemeCss", () => {
  it("accepts token overrides and trims them", () => {
    const result = sanitizeThemeCss('\n:root { --ds-bg: #101014; }\n');
    expect(result).toEqual({ ok: true, css: ":root { --ds-bg: #101014; }" });
  });

  it("accepts data: urls", () => {
    const result = sanitizeThemeCss('.a { background: url("data:image/svg+xml,%3Csvg%3E"); }');
    expect(result.ok).toBe(true);
  });

  it("rejects remote and relative urls", () => {
    expect(error(".a { background: url(https://x/y.png); }")).toMatch(/data: urls/);
    expect(error(".a { background: url(./y.png); }")).toMatch(/data: urls/);
    expect(error(".a { background: url( 'y.png' ); }")).toMatch(/data: urls/);
  });

  it("rejects a malformed url reference", () => {
    expect(error(".a { background: url(data:; }")).toMatch(/malformed/);
  });

  it("rejects stylesheet chaining", () => {
    expect(error('@import url("data:text/css,");')).toMatch(/@import/);
  });

  it("rejects markup and script expressions", () => {
    expect(error(":root {}</style><script>alert(1)</script>")).toMatch(/markup/);
    expect(error(".a { behavior: expression(alert(1)); }")).toMatch(/script expressions/);
    expect(error('.a { background: JavaScript:alert(1); }')).toMatch(/script expressions/);
  });

  it("rejects empty and oversized input", () => {
    expect(error("   \n ")).toMatch(/empty/);
    expect(error(`:root { --ds-bg: #000; }${" ".repeat(THEME_CSS_MAX_BYTES)}`)).toMatch(
      /exceeds 262144 bytes/,
    );
  });

  it("measures the cap in bytes, not characters", () => {
    const result = sanitizeThemeCss(`/*${"字".repeat(40)}*/:root{}`, 64);
    expect(result.ok).toBe(false);
  });
});
