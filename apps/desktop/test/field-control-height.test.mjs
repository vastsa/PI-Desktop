/**
 * Field/control height contract (renderer CSS).
 *
 * A text input, a native select and a menu-select trigger that acts as a form
 * field must resolve to one height, or the dropdown reads as a different-sized
 * control than the input beside it. `--ds-field-height` is that metric.
 *
 * Compact surfaces — a menu search row, the dense subagent sheet, the
 * Settings-row pill, the model row body — own a smaller metric instead. They
 * have to declare it as a *minimum*: the field vocabulary pins `min-height`, so
 * a bare `height` on one of their inputs would lose and the control would be
 * stretched to the field metric.
 *
 * These assertions read the stylesheets as text (no renderer harness), matching
 * the other CSS-contract tests in this directory.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [tokensCss, uiKitCss, settingsCss, modelConfigCss, extensionsCss, pluginsCss, scheduledCss, sessionsCss] =
  await Promise.all([
    read("../src/styles/tokens.css"),
    read("../src/styles/ui-kit.css"),
    read("../src/styles/settings.css"),
    read("../src/styles/model-config.css"),
    read("../src/styles/extensions.css"),
    read("../src/styles/plugins.css"),
    read("../src/features/scheduled/scheduled-editor.css"),
    read("../src/styles/sessions.css"),
  ]);

/** Body of one rule, so a declaration can be asserted inside the right block. */
function declarations(css, selectorText) {
  const escaped = selectorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `rule not found: ${selectorText}`);
  return match[1];
}

function heightValue(body, property) {
  // Anchored to a declaration line, so a comment that mentions "height:" in
  // prose cannot be mistaken for the declaration.
  const match = body.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`));
  assert.ok(match, `declaration not found: ${property}`);
  return match[1].trim();
}

test("the field vocabulary shares one height metric", () => {
  assert.match(
    tokensCss,
    /--ds-field-height:\s*calc\(18px \+ var\(--text-base\) \* var\(--leading-body\)\)/,
  );
  const field = declarations(uiKitCss, ".field-input,\n.field-select,\n.field-textarea");
  assert.equal(heightValue(field, "min-height"), "var(--ds-field-height)");
});

test("a stretched trigger takes the field metric without outranking a denser surface", () => {
  const stretched = declarations(
    settingsCss,
    ".settings-menu-select-anchor.is-full .settings-menu-select-trigger",
  );
  assert.match(stretched, /display:\s*flex/);
  assert.match(stretched, /width:\s*100%/);
  // Height lives in a `:where()` rule so it stays at field specificity: a
  // surface with its own metric must win with one class, not stylesheet order.
  assert.match(
    settingsCss,
    /:where\(\.settings-menu-select-anchor\.is-full\) \.settings-menu-select-trigger\s*\{[^}]*height:\s*var\(--ds-field-height\)/,
  );
  assert.doesNotMatch(stretched, /height:/);
});

test("dropdowns that act as form fields take the field metric", () => {
  for (const [css, selector] of [
    [pluginsCss, ".plugins-setting-control .settings-menu-select-trigger"],
    [pluginsCss, ".plugins-market-settings-control .settings-menu-select-trigger"],
    [scheduledCss, ".scheduled-fields .settings-menu-select-trigger"],
  ]) {
    assert.equal(
      heightValue(declarations(css, selector), "height"),
      "var(--ds-field-height)",
      selector,
    );
  }
});

test("a dense surface's dropdown matches that surface's own field height", () => {
  const sheetField = declarations(
    extensionsCss,
    ".ext-sheet .field-input,\n.ext-sheet .field-select,\n.ext-sheet .field-textarea",
  );
  const sheetTrigger = declarations(extensionsCss, ".ext-sheet .settings-menu-select-trigger");
  assert.equal(heightValue(sheetTrigger, "height"), heightValue(sheetField, "min-height"));

  const rowBodyField = declarations(
    modelConfigCss,
    ".provider-chosen-row-body .field-input,\n.provider-chosen-row-body .field-select",
  );
  const rowBodyTrigger = declarations(
    modelConfigCss,
    ".provider-chosen-thinking-select .settings-menu-select-trigger",
  );
  assert.equal(heightValue(rowBodyTrigger, "height"), heightValue(rowBodyField, "min-height"));
});

test("compact menu searches keep their own height as a minimum", () => {
  for (const selector of [".provider-service-search input", ".model-default-search input"]) {
    const body = declarations(modelConfigCss, selector);
    // Without the minimum, `--ds-field-height` wins over the row's 26px box and
    // the search swallows the menu row.
    assert.equal(heightValue(body, "min-height"), heightValue(body, "height"), selector);
    assert.equal(heightValue(body, "height"), "26px");
  }
});

test("a Settings-row dropdown matches the row's input", () => {
  const rowInput = declarations(settingsCss, ".settings-row-control .field-input");
  const pill = declarations(
    settingsCss,
    ".settings-pill-select,\n.settings-row-control .field-select",
  );
  const picker = declarations(
    settingsCss,
    ".settings-language-trigger,\n.settings-theme-trigger,\n.settings-menu-select-trigger,\n.settings-font-trigger",
  );
  // A Settings row can hold a text input, a select or a picker pill; all three
  // resolve to the shared field metric, so the column has one control height.
  assert.equal(heightValue(pill, "height"), "var(--ds-field-height)");
  assert.equal(heightValue(pill, "min-height"), "var(--ds-field-height)");
  for (const rule of [picker]) {
    assert.equal(heightValue(rule, "height"), "var(--ds-field-height)");
  }
  // The row's own text input takes the same metric through the field
  // vocabulary; a compact row input would have to declare its own minimum.
  assert.doesNotMatch(rowInput, /height:/);
});

test("the import toolbar's dropdown keeps the toolbar's own metric", () => {
  // That row holds 28px action buttons and no text input, so the shared field
  // metric would leave the dropdown taller than the controls beside it.
  const select = declarations(sessionsCss, ".import-option-select .settings-menu-select-trigger");
  assert.equal(heightValue(select, "height"), "28px");
  const button = declarations(sessionsCss, ".import-toolbar-actions > .btn");
  assert.equal(heightValue(button, "min-height"), "28px");
});
