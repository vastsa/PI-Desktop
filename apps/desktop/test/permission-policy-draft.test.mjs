import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { syncPermissionPolicyDraft } = await import("../src/features/settings/permission-policy-draft.ts");

test("pristine review-policy draft follows an external saved policy update", () => {
  assert.equal(syncPermissionPolicyDraft("original", "original", "updated"), "updated");
});

test("dirty review-policy draft survives an external saved policy update", () => {
  assert.equal(syncPermissionPolicyDraft("my unsaved policy", "original", "updated"), "my unsaved policy");
});
