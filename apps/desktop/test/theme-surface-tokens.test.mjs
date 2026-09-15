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

test("surface guard preserves tokens and excludes deferred prose, scrims, and shadows", () => {
  assert.deepEqual(findLiteralSurfaceColors(`
:root { --ds-settings-field-bg: #fff; }
/* .settings-search { background: #fff; } */
.settings-search { background: var(--ds-settings-field-bg); box-shadow: 0 1px 2px #000; }
.plugins-search:focus-visible { background: color-mix(in oklab, var(--ds-text-primary) 7%, transparent); }
.settings-search-clear { background: #fff; }
.plugins-modal-backdrop { background: #000; }
.prose { background: rgb(255, 255, 255); }
`), []);
});
