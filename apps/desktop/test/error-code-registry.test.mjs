import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCodes } from "@pi-desktop/shared";

/**
 * Keeps the three places an error code lives from drifting apart:
 * `ErrorCodes` (source of truth), the 08-error-codes spec, and the codes
 * host-core actually emits. A new code must land in all three at once.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

const errorCodesDoc = read("docs/spec/03-runtime/08-error-codes.md");
const documented = new Set(
  [...errorCodesDoc.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]),
);

/** Codes host-core emits as `errorCode` on JSON-RPC errors and tool results. */
function hostEmittedCodes() {
  const codes = new Set();
  const rpc = read("crates/host-core/src/rpc/mod.rs");
  for (const m of rpc.matchAll(/rpc_err\(\s*-?\d+,\s*[^;]*?"([A-Z][A-Z0-9_]+)"\s*,?\s*\)/gs)) {
    codes.add(m[1]);
  }
  for (const m of rpc.matchAll(/plan_rpc_err\("([A-Z][A-Z0-9_]+)/g)) codes.add(m[1]);
  const tools = read("crates/host-core/src/tools/mod.rs");
  for (const m of tools.matchAll(/\(\s*"([A-Z][A-Z0-9_]+)"\.into\(\)\s*,/g)) codes.add(m[1]);
  for (const m of tools.matchAll(/ToolError::new\(\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  const ignore = read("crates/host-core/src/tools/ignore_rules.rs");
  for (const m of ignore.matchAll(/DENIED_CODE: &str = "([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  return codes;
}

test("every registered error code is documented in 08-error-codes.md", () => {
  const missing = Object.keys(ErrorCodes).filter((code) => !documented.has(code));
  assert.deepEqual(missing, []);
});

test("every code host-core emits is registered in ErrorCodes", () => {
  const registry = new Set(Object.values(ErrorCodes));
  const missing = [...hostEmittedCodes()].filter((code) => !registry.has(code)).sort();
  assert.deepEqual(missing, []);
});
