import assert from "node:assert/strict";
import test from "node:test";
import { McpCallRegistry } from "../electron/main/mcp-call-registry.ts";

test("canceling one session leaves another MCP call active", async () => {
  const calls = new McpCallRegistry();
  let resolveOther;
  const canceled = calls.run("session-a", (signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const other = calls.run("session-b", (signal) => new Promise((resolve, reject) => {
    resolveOther = resolve;
    signal.addEventListener("abort", () => reject(new Error("wrong session aborted")), { once: true });
  }));

  calls.cancelSession("session-a");
  await assert.rejects(canceled, /aborted/);
  resolveOther("finished");
  assert.equal(await other, "finished");
});
