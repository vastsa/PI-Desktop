import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The task row's body toggles the log: the clickable surface is the whole lead
 * band (state dot, command, metadata), while stop / remove keep their own
 * behavior and stay outside it.
 */

const [dock, composerStyles] = await Promise.all([
  readFile(new URL("../src/components/TaskDock.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8"),
]);

test("the row body is an interactive element that toggles the log", () => {
  const main = dock.match(/<div\s+className="task-main"[\s\S]*?<\/div>/);
  assert.ok(main, "row body element missing");
  assert.match(main[0], /role="button"/);
  assert.match(main[0], /tabIndex=\{0\}/);
  assert.match(main[0], /aria-expanded=\{expanded\}/);
  assert.match(main[0], /onClick=\{\(\) => onToggleOutput\(task\.id\)\}/);
  // Keyboard parity with a real button.
  assert.match(main[0], /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(main[0], /if \(event\.target !== event\.currentTarget\) return;/);
});

test("the toggle surface covers the state dot, command and meta rows", () => {
  const main = dock.match(/<div\s+className="task-main"[\s\S]*?<\/div>/)[0];
  for (const className of ["task-state", "task-command", "task-meta"]) {
    assert.match(main, new RegExp(`className="${className}"`));
  }
});

test("stop and remove stay outside the toggle surface", () => {
  const toggleEnd = dock.indexOf('className="task-main"');
  const bandAt = dock.indexOf('className="task-band"');
  const stopAt = dock.indexOf('"task-action is-stop"');
  const removeAt = dock.indexOf('className="task-action"');
  assert.ok(bandAt > 0 && bandAt < toggleEnd, "the band must wrap the row body");
  assert.ok(stopAt > toggleEnd && removeAt > toggleEnd, "actions must follow the body");
});

test("a running task offers stop and never remove", () => {
  // The two actions are chosen by state in one branch: the stop control gates on
  // `running`, and the remove control lives in the other arm.
  assert.match(dock, /className="task-action is-stop"\s+onClick=\{\(\) => onStop\(task\.id\)\}/);
  assert.match(dock, /className="task-action"\s+onClick=\{\(\) => onRemove\(task\.id\)\}/);
  assert.match(dock, /backgroundTasks\.dismiss/);
  assert.ok(
    dock.indexOf('"task-action is-stop"') < dock.indexOf('className="task-action"'),
    "the stop control comes from the running arm",
  );
});

test("the row styles keep the body clickable and focus-visible", () => {
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*flex: 1 1 auto/);
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*cursor: pointer/);
  assert.match(
    composerStyles,
    /\.task-main:focus-visible\s*\{[^{}]*outline: 2px solid var\(--ds-focus\)/,
  );
});

test("a long command ellipsizes on one line instead of wrapping the row", () => {
  // The band must not wrap, and the command must own the ellipsis, or a long
  // command would push the metadata and its action onto a second line.
  assert.match(composerStyles, /\.task-band\s*\{[^{}]*flex-wrap: nowrap/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*text-overflow: ellipsis/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*white-space: nowrap/);
});
