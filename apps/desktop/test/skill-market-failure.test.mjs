import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  classifySkillMarketFailure,
  hasPolicyFailure,
  skillMarketFailureDetail,
} from "../src/lib/skill-market-failure.ts";

/**
 * Regression cover for issue #419: behind a proxy the main process can refuse a
 * skill market fetch inside its local-DNS public-network guard, and the install
 * sheet used to swallow that rejection and leave the install button disabled
 * with no reason. The renderer can only tell the two cases apart by the stable
 * error code the IPC wrapper forwards, so that mapping is what gets pinned here.
 */

test("a policy refusal is told apart from an ordinary network failure", () => {
  const policy = Object.assign(new Error("hostname resolves to a private address: api.github.com -> 198.18.0.4"), {
    code: ErrorCodes.NETWORK_POLICY_BLOCKED,
  });
  assert.equal(classifySkillMarketFailure(policy), "policy");

  for (const other of [
    Object.assign(new Error("responded 502"), { code: ErrorCodes.INTERNAL }),
    Object.assign(new Error("responded 404"), { code: ErrorCodes.NOT_FOUND }),
    new Error("no code at all"),
    "a bare string",
    undefined,
    null,
  ]) {
    assert.equal(classifySkillMarketFailure(other), "network", String(other));
  }
});

test("the sheet keeps the main-process reason and never invents one", () => {
  const policy = Object.assign(new Error("hostname does not resolve: api.github.com"), {
    code: ErrorCodes.NETWORK_POLICY_BLOCKED,
  });
  assert.equal(skillMarketFailureDetail(policy), "hostname does not resolve: api.github.com");
  assert.equal(skillMarketFailureDetail("plain"), "plain");
  assert.equal(skillMarketFailureDetail(undefined), "");
  assert.equal(skillMarketFailureDetail({}), "");
});

test("the app-level proxy hint appears only when a source was actually refused", () => {
  assert.equal(hasPolicyFailure({ "anthropics/skills": "policy" }), true);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasPolicyFailure({}), false);
  assert.equal(hasPolicyFailure(undefined), false);
});
