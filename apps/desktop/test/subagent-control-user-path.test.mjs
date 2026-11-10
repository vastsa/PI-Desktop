import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedRenderer } from "./helpers/isolated-renderer.mjs";

test("a user creates, steers, stops and continues a child without losing drafts or crossing sessions", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  timeout: 90_000,
}, async () => {
  const report = await runIsolatedRenderer("apps/desktop/test/e2e/subagent-control/fixture.tsx", "subagentControlProbe");
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 11);
  assert.ok(report.commands >= 5);
  assert.equal(report.unexpected, 0);
});
