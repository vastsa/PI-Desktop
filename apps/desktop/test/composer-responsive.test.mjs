import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const [toolbarSource, modelPickerSource] = await Promise.all([
  readFile(
    new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/features/chat/composer/ComposerModelPicker.tsx", import.meta.url),
    "utf8",
  ),
]);
const composerSource = `${toolbarSource}\n${modelPickerSource}`;

test("narrow composer containers progressively simplify the model controls", () => {
  assert.match(
    styles,
    /\.composer-stack\s*\{[\s\S]*?container-type:\s*inline-size;[\s\S]*?container-name:\s*composer-stack;/,
  );
  assert.match(styles, /\.composer-left,\s*\.composer-right\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.composer-model-thinking\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(
    styles,
    /@container composer-stack \(max-width: 560px\)[\s\S]*?\.composer-model-thinking-dot,[\s\S]*?\.composer-model-thinking-level[\s\S]*?display:\s*none;/,
  );
  assert.match(
    styles,
    /@container composer-stack \(max-width: 480px\)[\s\S]*?\.composer-model-thinking-model\s*\{[\s\S]*?max-width:\s*96px;/,
  );
  assert.match(
    styles,
    /@container composer-stack \(max-width: 450px\)[\s\S]*?\.composer-right \.composer-model-thinking-chip[\s\S]*?width:\s*32px;/,
  );
  assert.match(
    styles,
    /\.composer-model-thinking-model,\s*\.composer-model-thinking-chevron\s*\{[\s\S]*?display:\s*none;/,
  );
});


test("responsive rules preserve the semantic model trigger and action controls", () => {
  assert.match(composerSource, /className=\{`icon-btn composer-model-thinking-chip/);
  assert.match(composerSource, /ariaLabel=\{`\$\{t\("chat\.model"\)\}: \$\{modelLabel\}\./);
  assert.match(composerSource, /className=\"composer-model-thinking-chevron\"/);
  assert.match(composerSource, /ContextUsageInspector/);
  assert.match(composerSource, /className=\{`icon-btn icon-btn-square composer-enhance-btn/);
  assert.match(composerSource, /className="send-btn"/);
  assert.match(composerSource, /className="stop-btn"/);
});
