import assert from "node:assert/strict";
import test from "node:test";

import { remoteHostErrorKey } from "../src/lib/remote-host-errors.ts";
import { remoteEn, remoteZh } from "../src/locales/remote.ts";

test("remoteHostErrorKey maps a failed SSH bootstrap to a dedicated message", () => {
  const error = Object.assign(new Error("ssh command failed with exit code 255: Permission denied, please try again."), {
    errorCode: "HOST_BOOTSTRAP_FAILED",
  });
  assert.equal(remoteHostErrorKey(error), "remote:hostBootstrapFailed");
});

test("remoteHostErrorKey reads the IPC-wire `code` field as a fallback", () => {
  const error = Object.assign(new Error("bootstrap failed"), { code: "HOST_BOOTSTRAP_FAILED" });
  assert.equal(remoteHostErrorKey(error), "remote:hostBootstrapFailed");
});

test("remoteHostErrorKey falls back to the generic message for an unmapped code", () => {
  const error = Object.assign(new Error("boom"), { errorCode: "SOME_UNKNOWN_CODE" });
  assert.equal(remoteHostErrorKey(error), "remote:operationFailed");
});

test("hostBootstrapFailed has an English and Chinese translation distinct from the generic fallback", () => {
  assert.equal(typeof remoteEn.hostBootstrapFailed, "string");
  assert.equal(typeof remoteZh.hostBootstrapFailed, "string");
  assert.notEqual(remoteEn.hostBootstrapFailed, remoteEn.operationFailed);
  assert.notEqual(remoteZh.hostBootstrapFailed, remoteZh.operationFailed);
});
