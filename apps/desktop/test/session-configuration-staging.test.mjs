import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const store = readFileSync(join(here, "../src/stores/app-store.ts"), "utf8");

const between = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
};

test("staged next-turn configuration merges per field instead of replacing", () => {
  const merge = between(
    store,
    "function mergeSessionConfiguration(",
    "\n}\n",
  );
  // Only defined fields overwrite; an omitted permissionMode keeps the staged one.
  assert.match(merge, /if \(!current\) return next;/);
  assert.match(merge, /if \(value !== undefined\) merged\[key\] = value;/);
  assert.match(
    store,
    /pendingSessionConfigurations\.set\(\n\s*sessionId,\n\s*mergeSessionConfiguration\(pendingSessionConfigurations\.get\(sessionId\), config\),\n\s*\)/,
  );
  // The direct (idle) path folds a leftover staged entry under the new fields.
  assert.match(
    store,
    /const payload = mergeSessionConfiguration\(\n\s*pendingSessionConfigurations\.get\(sessionId\),\n\s*config,\n\s*\);\n\s*pendingSessionConfigurations\.delete\(sessionId\);\n\s*const result = await api\.configureSession\(sessionId, payload\);/,
  );
});

test("a failed flush keeps the staged configuration instead of dropping it", () => {
  const flush = between(
    store,
    "function flushPendingSessionConfiguration(",
    "\n}\n",
  );
  const call = flush.indexOf("await api.configureSession(sessionId, config)");
  const drop = flush.indexOf("pendingSessionConfigurations.delete(sessionId)");
  assert.ok(call >= 0 && drop > call, "the entry must outlive the host call");
  // Only the exact entry that was sent is cleared, so a choice staged while
  // the call was in flight survives.
  assert.match(
    flush,
    /if \(pendingSessionConfigurations\.get\(sessionId\) === config\) \{\n\s*pendingSessionConfigurations\.delete\(sessionId\);/,
  );
  // On failure the loop exits rather than retrying the same payload blind, and
  // the settle handler does not immediately re-enter the flush.
  assert.match(flush, /catch \(error\) \{[\s\S]*?failed = true;\n\s*break;/);
  assert.match(flush, /!failed &&\n\s*pendingSessionConfigurations\.has\(sessionId\)/);
});
