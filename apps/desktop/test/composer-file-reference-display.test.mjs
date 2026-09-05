import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [autocomplete, autocompleteHook, autocompleteStyles, composer, composerStyles] =
  await Promise.all([
    read("../src/components/ComposerAutocomplete.tsx"),
    read("../src/hooks/use-composer-autocomplete.ts"),
    read("../src/styles/composer-autocomplete.css"),
    read("../src/components/Composer.tsx"),
    read("../src/styles/composer.css"),
  ]);

test("file autocomplete rows keep the path out of the persistent label", () => {
  assert.match(
    autocomplete,
    /const displayName = `\$\{name\}\$\{isDir \? "\/" : ""\}`/,
  );
  assert.match(autocomplete, /className="composer-ac-name">\{displayName\}/);
  assert.doesNotMatch(autocomplete, /composer-ac-path/);
  assert.doesNotMatch(autocompleteStyles, /\.composer-ac-path/);
});

test("accepted files become compact references while directories keep completion", () => {
  assert.match(autocomplete, /title=\{item\.entry\.path\}/);
  assert.match(
    autocomplete,
    /aria-label=\{`\$\{displayName\} — \$\{item\.entry\.path\}`\}/,
  );
  assert.match(
    autocompleteHook,
    /item\.kind === "path" && item\.entry\.kind === "file"/,
  );
  assert.match(autocompleteHook, /\.\.\.applyCompletion\(value, trigger, ""\)/);
  assert.match(autocompleteHook, /path: item\.entry\.path/);
  assert.match(
    autocompleteHook,
    /formatFileInsert\(item\.entry\.path, item\.entry\.kind\)/,
  );
});

test("composer renders atomic inline chips and serializes paths on send", () => {
  // Chips are atomic non-editable elements inside the contenteditable draft,
  // one per sentinel token, with an ellipsized leaf name.
  assert.match(composer, /className = "composer-chip"/);
  assert.match(composer, /chip\.contentEditable = "false"/);
  assert.match(composer, /chip\.dataset\.token = token/);
  assert.match(composer, /composer-chip-name/);
  assert.match(composer, /nameSpan\.textContent = reference\.name/);
  assert.match(composer, /chip\.title = reference\.path/);
  assert.match(
    composer,
    /serializeComposerFileReferences\(text, activeFileReferences\)/,
  );
  assert.match(composer, /sendPrompt\(inlineContent, submittedDraft\)/);
  assert.match(composer, /serializeInlineComposerFileReferences\(/);
  assert.match(composer, /current\.filter\(/);
  assert.match(
    composerStyles,
    /\.composer-chip-name[\s\S]*?text-overflow: ellipsis/,
  );
});

test("unanswered stop restores compact references instead of serialized paths", () => {
  assert.match(composer, /setValue\(composerPrefill\.text\)/);
  assert.match(composer, /composerPrefill\.fileReferences\.map/);
  assert.match(composer, /composerPrefill\.sessionId !== activeSessionId/);
  assert.match(
    composer,
    /createFileReference\(\s*fileReference\.path,\s*fileReference\.name,\s*composerPrefill\.sessionId/,
  );
  assert.doesNotMatch(composer, /setValue\(composerPrefill\);/);
});
