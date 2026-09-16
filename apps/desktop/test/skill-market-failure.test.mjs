import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  classifySkillMarketFailure,
  hasPolicyFailure,
  hasUnresolvedFailure,
  skillMarketFailureDetail,
} from "../src/lib/skill-market-failure.ts";

/**
 * Regression cover for issue #419: behind a proxy the main process can refuse a
 * skill market fetch inside its local-DNS public-network guard, and the install
 * sheet used to swallow that rejection and leave the install button disabled
 * with no reason. The renderer can only tell the cases apart by the stable error
 * code the IPC wrapper forwards, so that mapping is what gets pinned here.
 *
 * Two refusals, not one: an address the guard *judged* is a policy decision,
 * while a resolver that answered nothing never reached a verdict. Reporting the
 * second as the first is what told a proxied user their sources were "blocked by
 * the app's address check" when no address had been classified.
 */

test("a judged address, an unanswered resolver and a dead host are three cases", () => {
  const judged = Object.assign(
    new Error("hostname resolves to a non-public address: api.github.com -> 198.18.0.4 (benchmark)"),
    { code: ErrorCodes.NETWORK_POLICY_BLOCKED },
  );
  assert.equal(classifySkillMarketFailure(judged), "policy");

  const unresolved = Object.assign(new Error("hostname does not resolve: api.github.com (ENOTFOUND)"), {
    code: ErrorCodes.NETWORK_RESOLVE_FAILED,
  });
  assert.equal(classifySkillMarketFailure(unresolved), "unresolved");

  for (const other of [
    Object.assign(new Error("responded 502"), { code: ErrorCodes.INTERNAL }),
    Object.assign(new Error("responded 403"), { code: ErrorCodes.RATE_LIMITED }),
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
  const unresolved = Object.assign(new Error("hostname does not resolve: api.github.com"), {
    code: ErrorCodes.NETWORK_RESOLVE_FAILED,
  });
  assert.equal(skillMarketFailureDetail(unresolved), "hostname does not resolve: api.github.com");
  assert.equal(skillMarketFailureDetail("plain"), "plain");
  assert.equal(skillMarketFailureDetail(undefined), "");
  assert.equal(skillMarketFailureDetail({}), "");
});

test("the two hints are chosen by cause, not by failure count", () => {
  // An address-level refusal is the stronger statement and leads; a resolver
  // that answered nothing gets the resolver hint instead. Neither may claim the
  // other's cause.
  assert.equal(hasPolicyFailure({ "anthropics/skills": "policy" }), true);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "unresolved" }), false);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasPolicyFailure({}), false);
  assert.equal(hasPolicyFailure(undefined), false);

  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "unresolved" }), true);
  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "policy" }), false);
  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasUnresolvedFailure({}), false);
  assert.equal(hasUnresolvedFailure(undefined), false);
});
