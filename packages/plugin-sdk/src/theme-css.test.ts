import { describe, expect, it } from "vitest";
import {
  decodeCssEscapes,
  isThemeAssetPath,
  maskNonCodeCss,
  normalizeThemeAssetPath,
  sanitizeThemeCss,
  themeAssetUrl,
  THEME_CSS_MAX_BYTES,
  type ThemeCssAssetResolver,
} from "./theme-css.js";

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

  it("rejects @import spelled with CSS escapes", () => {
    expect(error('@\\69mport url("data:text/css,");')).toMatch(/@import/);
    expect(error('@\\000069 mport "x.css";')).toMatch(/@import/);
    expect(error('@\\im\\port "x.css";')).toMatch(/@import/);
  });

  it("rejects url() spelled with CSS escapes", () => {
    expect(error(".a { background: \\75rl(https://x/y.png); }")).toMatch(/data: urls/);
    expect(error(".a { background: u\\72 l(https://x/y.png); }")).toMatch(/data: urls/);
    expect(error(".a { background: \\75rl(data:; }")).toMatch(/malformed/);
  });

  it("still accepts escapes that do not spell a banned token", () => {
    const result = sanitizeThemeCss('.a::before { content: "\\201C"; --x: \\31 0px; }');
    expect(result.ok).toBe(true);
  });

  it("decodes hex and single-character escapes", () => {
    expect(decodeCssEscapes("\\69mport \\75rl \\@ \\000041")).toBe("import url @ A");
    expect(decodeCssEscapes("\\0 x")).toBe("\ufffdx");
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

describe("sanitizeThemeCss comment and string handling", () => {
  it("ignores keywords that only appear in a comment", () => {
    const result = sanitizeThemeCss(
      "/* No @import here: </style> and expression( are only named. */\n:root { --ds-bg: #101014; }",
    );
    expect(result.ok).toBe(true);
  });

  it("ignores a url() form that only appears in a comment", () => {
    expect(sanitizeThemeCss("/* url() */\n:root { --ds-bg: #101014; }").ok).toBe(true);
    expect(sanitizeThemeCss('/* url("") */\n:root { --ds-bg: #101014; }').ok).toBe(true);
    expect(sanitizeThemeCss("/* url(https://x/y.png) */\n:root { --ds-bg: #101014; }").ok).toBe(
      true,
    );
  });

  it("ignores keywords that only appear inside a string", () => {
    expect(sanitizeThemeCss('.a { content: "@import"; }').ok).toBe(true);
    expect(sanitizeThemeCss('.a { content: "url()"; }').ok).toBe(true);
    expect(sanitizeThemeCss('.a { content: "url(https://x/y.png)"; }').ok).toBe(true);
  });

  it("does not let an opening quote in a string open a comment", () => {
    const css = '.a { content: "/*"; }\n@import "x.css";\n.b { color: red; }';
    expect(error(css)).toMatch(/@import/);
  });

  it("does not let a quote inside a comment open a string", () => {
    const css = '/* an unterminated "quote */\n.a { background: url(https://x/y.png); }';
    expect(error(css)).toMatch(/data: urls/);
  });

  it("still reports a real reference that follows a masked one", () => {
    const css = '/* url(https://decoy.example/a.png) */\n.a { background: url(https://x/y.png); }';
    expect(error(css)).toMatch(/found "https:\/\/x\/y.png"/);
  });

  it("keeps markup and script checks working outside comments", () => {
    expect(error("/* ok */\n:root {}</style>")).toMatch(/markup/);
    expect(error("/* ok */\n.a { background: JavaScript:alert(1); }")).toMatch(
      /script expressions/,
    );
  });

  it("still rejects an escaped keyword written after a comment", () => {
    const css = '/* mentions nothing */\n@\\69mport url("data:text/css,");';
    expect(error(css)).toMatch(/@import/);
  });

  it("accepts a sheet whose only content is a comment", () => {
    expect(sanitizeThemeCss("/* </style> */").ok).toBe(true);
  });
});

describe("maskNonCodeCss", () => {
  it("preserves length and the position of real code", () => {
    const css = '/* c */ .a { content: "s"; background: url("data:x"); }';
    const masked = maskNonCodeCss(css);
    expect(masked).toHaveLength(css.length);
    expect(masked.indexOf(".a")).toBe(css.indexOf(".a"));
    expect(masked.indexOf("url(")).toBe(css.indexOf("url("));
  });

  it("blanks comment and string bodies", () => {
    expect(maskNonCodeCss("a/*b*/c")).toBe(`a${" ".repeat(5)}c`);
    expect(maskNonCodeCss('a"b"c')).toBe(`a${" ".repeat(3)}c`);
  });

  it("keeps a url() argument intact, quoted or not", () => {
    expect(maskNonCodeCss('url("data:a")')).toBe('url("data:a")');
    expect(maskNonCodeCss("url( data:a )")).toBe("url( data:a )");
  });

  it("treats an unterminated url() as code to the end of the sheet", () => {
    const css = ".a { background: url(data:; }";
    expect(maskNonCodeCss(css)).toBe(css);
  });

  it("does not mistake a url() inside a string for a reference", () => {
    expect(maskNonCodeCss('.a { content: "url(x)"; }')).toBe(
      `.a { content: ${" ".repeat(8)}; }`,
    );
  });
});

describe("theme assets", () => {
  const ASSET = "assets/bg.png";
  const resolveAsset: ThemeCssAssetResolver = (target) => {
    const normalized = normalizeThemeAssetPath(target);
    return normalized === ASSET ? themeAssetUrl("demo.hello", normalized) : null;
  };

  it("rewrites a package-relative reference to the host scheme", () => {
    const result = sanitizeThemeCss(
      `.a { background: url("${ASSET}") no-repeat; }`,
      undefined,
      resolveAsset,
    );
    expect(result).toEqual({
      ok: true,
      css: `.a { background: url("plugin-asset://demo.hello/${ASSET}") no-repeat; }`,
    });
  });

  it("accepts the normalized package-relative spelling of the same asset", () => {
    const result = sanitizeThemeCss(".a { background: url(./assets/bg.png); }", undefined, resolveAsset);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.css).toContain(`plugin-asset://demo.hello/${ASSET}`);
    }
  });

  it("refuses a reference the resolver does not own", () => {
    const result = sanitizeThemeCss(
      '.a { background: url("C:/art/other.png"); }',
      undefined,
      resolveAsset,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/declared assets/);
  });

  it("leaves data: urls alone", () => {
    const result = sanitizeThemeCss(
      '.a { background: url("data:image/png;base64,AA"); }',
      undefined,
      resolveAsset,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.css).toContain("data:image/png;base64,AA");
  });

  it("does not rewrite a reference inside a comment", () => {
    const css = `/* url(${ASSET}) */\n.a { color: red; }`;
    expect(sanitizeThemeCss(css, undefined, resolveAsset)).toEqual({ ok: true, css });
  });

  it("accepts normalized package-relative and absolute paths", () => {
    expect(isThemeAssetPath(ASSET)).toBe(true);
    expect(normalizeThemeAssetPath("assets\\bg.png")).toBe(ASSET);
    expect(normalizeThemeAssetPath("./assets/bg.png")).toBe(ASSET);
    expect(normalizeThemeAssetPath("C:\\art\\bg.png")).toBe("C:/art/bg.png");
    expect(normalizeThemeAssetPath("file:///C:/art/bg.png")).toBe("C:/art/bg.png");
    expect(normalizeThemeAssetPath("/art/bg.png")).toBe("/art/bg.png");
    for (const refused of [
      "../escape.png",
      "art/../../x.png",
      "art//bg.png",
      "assets/bg.gif",
      "C:/art/../bg.png",
      "https://x/y.png",
      "",
    ]) {
      expect(normalizeThemeAssetPath(refused)).toBe("");
      expect(isThemeAssetPath(refused)).toBe(false);
    }
  });

  it("builds host urls for package-relative and absolute paths", () => {
    expect(themeAssetUrl("demo.hello", ASSET)).toBe(
      `plugin-asset://demo.hello/${ASSET}`,
    );
    expect(themeAssetUrl("demo.hello", "C:/art/bg.png")).toBe(
      `plugin-asset://demo.hello/${encodeURIComponent("C:/art/bg.png")}`,
    );
  });
});
describe("the example theme shape", () => {
  it("loads a sheet whose header comment explains the @import ban", () => {
    // The wording `examples/plugins/hello/themes/midnight.css` ships with;
    // `plugin-themes.test.mjs` runs the shipped file itself through this code.
    const css = `/*
  Theme contributed by the Hello example plugin.

  Contributed CSS is sanitized by the host (no @import, no remote url(), 256KB
  cap) and injected after the app's own stylesheets, so overriding a --ds-*
  token is enough.
*/
:root[data-theme="dark"] {
  --ds-bg-primary: #0d1424;
}`;
    expect(css).toContain("@import");
    expect(sanitizeThemeCss(css).ok).toBe(true);
  });
});
