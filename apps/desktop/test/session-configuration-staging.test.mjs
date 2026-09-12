import { readStoreModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sessionRuntime = readStoreModuleSync("runtime/session-runtime.ts");
const sessionCoordination = readStoreModuleSync("runtime/session-coordination.ts");
const sessionSlice = readStoreModuleSync("slices/session-slice.ts");

const between = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
};

test("staged next-turn configuration merges per field instead of replacing", () => {
  const merge = between(
    sessionRuntime,
    "mergeSessionConfiguration: (",
    "\n    queueWorkspaceAlignment,",
  );
  // Only defined fields overwrite; an omitted permissionMode keeps the staged one.
  assert.match(merge, /if \(!current\) return next;/);
  assert.match(merge, /if \(value !== undefined\) merged\[key\] = value;/);
  assert.match(
    sessionSlice,
    /runtime\.pendingSessionConfigurations\.set\(\n\s*sessionId,\n\s*runtime\.mergeSessionConfiguration\(\n\s*runtime\.pendingSessionConfigurations\.get\(sessionId\),\n\s*config,\n\s*\),\n\s*\)/,
  );
  // The direct (idle) path folds a leftover staged entry under the new fields.
  assert.match(
    sessionSlice,
    /const payload = runtime\.mergeSessionConfiguration\(\n\s*runtime\.pendingSessionConfigurations\.get\(sessionId\),\n\s*config,\n\s*\);\n\s*runtime\.pendingSessionConfigurations\.delete\(sessionId\);\n\s*const result = await api\.configureSession\(sessionId, payload\);/,
  );
});

test("a failed flush keeps the staged configuration instead of dropping it", () => {
  const flush = between(
    sessionCoordination,
    "function flushPendingSessionConfiguration(",
    "\n  function rememberSessionCompactions",
  );
  const call = flush.indexOf("await api.configureSession(sessionId, config)");
  const drop = flush.indexOf("runtime.pendingSessionConfigurations.delete(sessionId)");
  assert.ok(call >= 0 && drop > call, "the entry must outlive the host call");
  // Only the exact entry that was sent is cleared, so a choice staged while
  // the call was in flight survives.
  assert.match(
    flush,
    /if \(runtime\.pendingSessionConfigurations\.get\(sessionId\) === config\) \{\n\s*runtime\.pendingSessionConfigurations\.delete\(sessionId\);/,
  );
  // On failure the loop exits rather than retrying the same payload blind, and
  // the settle handler does not immediately re-enter the flush.
  assert.match(flush, /catch \(error\) \{[\s\S]*?failed = true;\n\s*break;/);
  assert.match(flush, /!failed &&\n\s*runtime\.pendingSessionConfigurations\.has\(sessionId\)/);
});
