import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * `pi.ui.injectStyle` (`docs/plugin-plan/slot-contract.html` §4): a plugin's
 * style rules apply inside its own slot mounts only, rules that define names
 * stay global, and `@import` is dropped. The browser parses the sheet, so the
 * scoper is driven here with the rule objects the CSS engine hands back.
 */
const { scopedPluginCss, injectPluginStyle } = await import(
  "../src/plugins/renderer-slots/style-injection.ts"
);

const rule = (kind, cssText) => ({ cssText, constructor: { name: kind } });

test("style rules, also inside group rules, go into the plugin's scope in source order", () => {
  const css = scopedPluginCss("demo.lab", [
    rule("CSSStyleRule", ".card { color: red; }"),
    rule("CSSMediaRule", "@media (width > 600px) { .card { padding: 8px; } }"),
    rule("CSSSupportsRule", "@supports (display: grid) { .grid { display: grid; } }"),
    rule("CSSContainerRule", "@container (width > 10px) { .x { margin: 0; } }"),
    rule("CSSLayerBlockRule", "@layer lab { .y { gap: 1px; } }"),
    rule("CSSScopeRule", "@scope (.card) { p { margin: 0; } }"),
    rule("CSSStartingStyleRule", "@starting-style { .card { opacity: 0; } }"),
  ]);
  assert.equal(
    css,
    [
      '@scope ([data-pi-plugin="demo.lab"]) {',
      ".card { color: red; }",
      "@media (width > 600px) { .card { padding: 8px; } }",
      "@supports (display: grid) { .grid { display: grid; } }",
      "@container (width > 10px) { .x { margin: 0; } }",
      "@layer lab { .y { gap: 1px; } }",
      "@scope (.card) { p { margin: 0; } }",
      "@starting-style { .card { opacity: 0; } }",
      "}",
    ].join("\n"),
  );
});

test("rules that define names stay global and come first; @import is dropped", () => {
  const css = scopedPluginCss("demo.lab", [
    rule("CSSImportRule", '@import url("https://example.invalid/x.css");'),
    rule("CSSStyleRule", ".spin { animation: lab-spin 1s; }"),
    rule("CSSKeyframesRule", "@keyframes lab-spin { to { rotate: 1turn; } }"),
    rule("CSSFontFaceRule", '@font-face { font-family: "Lab"; src: local("Lab"); }'),
    rule("CSSPropertyRule", "@property --lab-angle { syntax: \"<angle>\"; inherits: false; initial-value: 0deg; }"),
    rule("CSSLayerStatementRule", "@layer lab, lab2;"),
  ]);
  const lines = css.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "@keyframes lab-spin { to { rotate: 1turn; } }",
    '@font-face { font-family: "Lab"; src: local("Lab"); }',
    "@property --lab-angle { syntax: \"<angle>\"; inherits: false; initial-value: 0deg; }",
    "@layer lab, lab2;",
  ]);
  assert.deepEqual(lines.slice(4), [
    '@scope ([data-pi-plugin="demo.lab"]) {',
    ".spin { animation: lab-spin 1s; }",
    "}",
  ]);
  assert.doesNotMatch(css, /@import/);
});

test("a sheet without style rules adds no scope, and the scope id is a CSS string", () => {
  assert.equal(
    scopedPluginCss("demo.lab", [rule("CSSKeyframesRule", "@keyframes a { }")]),
    "@keyframes a { }",
  );
  assert.equal(scopedPluginCss("demo.lab", []), "");
  assert.match(
    scopedPluginCss('odd"id\\x\ny', [rule("CSSStyleRule", "p { }")]),
    /^@scope \(\[data-pi-plugin="odd\\"id\\\\x\\a y"\]\) \{/,
  );
});

test("injectStyle adds one scoped <style> per sheet and its disposer removes it once", (t) => {
  const originalDocument = globalThis.document;
  const originalSheet = globalThis.CSSStyleSheet;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.CSSStyleSheet = originalSheet;
  });
  const head = [];
  globalThis.document = {
    head: { appendChild: (element) => head.push(element) },
    createElement: (tag) => {
      const element = {
        tag,
        attributes: {},
        textContent: "",
        setAttribute(name, value) {
          element.attributes[name] = value;
        },
        remove() {
          const at = head.indexOf(element);
          if (at >= 0) head.splice(at, 1);
          element.removed = (element.removed ?? 0) + 1;
        },
      };
      return element;
    },
  };
  // The engine's reading of the text: one style rule and one keyframes rule.
  globalThis.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
      this.cssRules = [
        rule("CSSStyleRule", ".card { color: red; }"),
        rule("CSSKeyframesRule", "@keyframes lab { }"),
      ];
    }
  };

  const dispose = injectPluginStyle("demo.lab", ".card { color: red } @keyframes lab {}");
  assert.equal(head.length, 1);
  const [style] = head;
  assert.equal(style.tag, "style");
  assert.deepEqual(style.attributes, { "data-pi-plugin-style": "demo.lab" });
  assert.equal(
    style.textContent,
    '@keyframes lab { }\n@scope ([data-pi-plugin="demo.lab"]) {\n.card { color: red; }\n}',
  );
  dispose();
  dispose();
  assert.equal(head.length, 0);
  assert.equal(style.removed, 1, "the disposer is idempotent");

  for (const css of [undefined, null, 3, { toString: () => "p {}" }]) {
    assert.throws(() => injectPluginStyle("demo.lab", css), TypeError);
  }
  assert.equal(head.length, 0);
});
