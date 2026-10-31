import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [sessionSlice, workPanelSlice] = await Promise.all([
  read("../src/stores/slices/session-slice.ts"),
  read("../src/stores/slices/work-panel-slice.ts"),
]);

function callAt(source, needle) {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `${needle} missing`);
  return source.slice(start, start + 500);
}

test("a background session-pin write reports a refusal", () => {
  // The active-session branch flushes through a catch that toasts. A pin on
  // another session must not be the one path that drops its failure: the row
  // keeps the optimistic value while the host still holds the old model.
  const call = callAt(sessionSlice, "api.configureSession(id,");
  assert.match(call, /\.catch\(/);
  assert.match(call, /showToast/);
  // The active-session branch is unchanged: it reports through its flush.
  assert.match(sessionSlice, /void get\(\)\.configureActiveSession\(/);
});

test("the OS-browser fallback reports a refused open", () => {
  // shell.openExternal rejects when the platform has no handler or a policy
  // blocks the URL; without a catch the click is indistinguishable from a
  // no-op, which is how the sibling pluginViewClose path already handles it.
  const call = callAt(workPanelSlice, "browserOpenExternal(url.trim())");
  assert.match(call, /\.catch\(/);
  assert.match(call, /showToast/);
});
