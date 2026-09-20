import assert from "node:assert/strict";
import test from "node:test";
import { findLiteralSurfaceColors } from "../../../scripts/style-surface-tokens.mjs";

test("surface guard catches literal fills on base, theme, and focus rules", () => {
  const violations = findLiteralSurfaceColors(`
.settings-search { background: #fff; }
:root[data-theme="dark"] .composer-shell { background-color: rgba(33, 33, 33, .96); }
@media (min-width: 600px) {
  :root[data-theme="light"] .plugins-search:focus-visible {
    background: color-mix(in oklab, var(--ds-text-primary) 5%, white);
  }
}`);
  assert.deepEqual(violations.map(({ line }) => line), [2, 3, 6]);
});

test("surface guard preserves tokens and the enumerated exemptions", () => {
  assert.deepEqual(
    findLiteralSurfaceColors(`
:root { --ds-settings-field-bg: #fff; }
/* .settings-search { background: #fff; } */
.settings-search { background: var(--ds-settings-field-bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
.plugins-search:focus-visible { background: color-mix(in oklab, var(--ds-text-primary) 7%, transparent); }
.settings-search-clear { background: #fff; }
.search-overlay { background: color-mix(in oklab, #000 45%, transparent); }
.code-block-lang { color: color-mix(in oklab, #383a42 62%, transparent); }
.prose { background: rgb(255, 255, 255); }
`),
    [],
  );
});

test("surface guard holds every theme override to the token contract", () => {
  /*
    Issue #341: a literal inside a :root[data-theme] rule raises specificity
    above the base token rule and does not read a variable, so that surface drops
    out of every contributed theme's reach. The Shiki syntax palette, a
    black-alpha shadow, and the token blocks themselves stay exempt.
  */
  const violations = findLiteralSurfaceColors(`
:root[data-theme="light"] .prose-chat h5 { color: color-mix(in oklab, #1a1c1f 62%, transparent); }
:root[data-theme="light"] .prose-chat pre { background: #fafafa; color: #383a42; }
:root[data-theme="dark"] .overlay { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22); }
:root[data-theme="dark"] .toast { box-shadow: 0 1px 2px rgba(20, 20, 20, 0.22); }
:root[data-theme="light"] .code-block { --code-block-bg: #1a1c1f; }
:root[data-theme="light"] { --ds-bg-primary: #ffffff; }
:root[data-theme="light"] .plugins-search { background: var(--ds-field-inset-bg); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "color"],
      [5, "box-shadow"],
      [6, "--code-block-bg"],
    ],
  );
});

test("surface guard covers the tokenized families and every opaque colour form", () => {
  /*
    The migrated families are a fixed list that includes the code-card and
    Mermaid variants tokenized in issue #341, and the checked property set spans
    shorthand borders, background images, text shadows and filters — so a literal
    cannot slip back in through a property nobody listed.
  */
  const violations = findLiteralSurfaceColors(`
.code-block-head { background: #123456; }
.mermaid-block-body { background: rgb(255, 255, 255); }
.search-overlay .search-dialog { border: 1px solid #000; }
.overlay { background-image: linear-gradient(#fff, #000); }
.tool-row-content { text-shadow: 0 1px 2px #101010; }
:root[data-theme="dark"] .prose-chat kbd { filter: drop-shadow(#336699 0 1px 2px); }
:root[data-theme="dark"] .toast { box-shadow: 0 0 0 1px #ffffff; }
.plugins-modal-backdrop { background: var(--ds-modal-veil); }
:root[data-theme="light"] .mermaid-block-body { background: var(--ds-mermaid-canvas); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "background"],
      [3, "background"],
      [4, "border"],
      [5, "background-image"],
      [6, "text-shadow"],
      [7, "filter"],
      [8, "box-shadow"],
    ],
  );
});
