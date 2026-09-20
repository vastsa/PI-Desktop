import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  classifySkillMarketFailure,
  hasFakeIpFailure,
  hasPolicyFailure,
  hasUnresolvedFailure,
  skillMarketFailureDetail,
} from "../src/lib/skill-market-failure.ts";

/**
 * Regression cover for issue #419: behind a proxy the main process can refuse a
 * skill market fetch inside its local-DNS public-network guard, and the install
 * sheet used to swallow that rejection and leave the install button disabled
 * with no reason. The renderer can only tell the cases apart by what the IPC
 * wrapper forwards, so that mapping is what gets pinned here.
 *
 * Four causes, not one. An address the guard judged and the target's own is a
 * policy decision; the same refusal applied to an address the *local proxy*
 * invented (Clash's `198.18.0.0/15` fake-IP pool) is a different finding with
 * different advice; a resolver that answered nothing reached no verdict; and
 * everything else is a transport failure. Reporting the middle two as the first
 * is what told a proxied user their sources were "blocked by the app's address
 * check".
 */

test("a judged fake-IP, a judged private target, an unanswered resolver and a dead host are four cases", () => {
  // The guard's own `data` reaches the renderer as `error.details` (register.ts
  // `wrap()`), which is the only thing that separates these two: both arrive
  // under NETWORK_POLICY_BLOCKED, because both are refusals the guard decided.
  const fakeIp = Object.assign(
    new Error("hostname resolves to a non-public address: api.github.com -> 198.18.0.1 (benchmark)"),
    {
      code: ErrorCodes.NETWORK_POLICY_BLOCKED,
      details: {
        reason: "non-public-address",
        host: "api.github.com",
        address: "198.18.0.1",
        addressKind: "benchmark",
      },
    },
  );
  assert.equal(classifySkillMarketFailure(fakeIp), "fake-ip");

  const privateTarget = Object.assign(
    new Error("hostname resolves to a non-public address: api.github.com -> 10.1.2.3 (private)"),
    {
      code: ErrorCodes.NETWORK_POLICY_BLOCKED,
      details: {
        reason: "non-public-address",
        host: "api.github.com",
        address: "10.1.2.3",
        addressKind: "private",
      },
    },
  );
  assert.equal(classifySkillMarketFailure(privateTarget), "policy");

  const judged = Object.assign(
    new Error("hostname resolves to a non-public address: api.github.com -> 198.18.0.4 (benchmark)"),
    { code: ErrorCodes.NETWORK_POLICY_BLOCKED },
  );
  assert.equal(classifySkillMarketFailure(judged), "policy");

  const unresolved = Object.assign(new Error("hostname does not resolve: api.github.com (ENOTFOUND)"), {
    code: ErrorCodes.NETWORK_RESOLVE_FAILED,
    details: { reason: "resolve-failed", host: "api.github.com" },
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

test("a refusal whose details did not survive the boundary stays a refusal", () => {
  // `details` is an optimisation for the explanation, never a precondition for
  // blocking. A refusal that arrives without it must not degrade to "network",
  // which would tell the user the source is unreachable.
  const bare = Object.assign(new Error("hostname resolves to a non-public address"), {
    code: ErrorCodes.NETWORK_POLICY_BLOCKED,
  });
  assert.equal(classifySkillMarketFailure(bare), "policy");
  // An unrecognized class must not be read as fake-IP either.
  const unknownClass = Object.assign(new Error("hostname resolves to a non-public address"), {
    code: ErrorCodes.NETWORK_POLICY_BLOCKED,
    details: { reason: "non-public-address", addressKind: "made-up" },
  });
  assert.equal(classifySkillMarketFailure(unknownClass), "policy");
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

test("the three hints are chosen by cause, not by failure count", () => {
  // A refusal of the target's own address is the strongest statement and leads;
  // a proxy fake-IP gets the proxy-mode hint; a resolver that answered nothing
  // gets the resolver hint. None may claim another's cause.
  assert.equal(hasPolicyFailure({ "anthropics/skills": "policy" }), true);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "fake-ip" }), false);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "unresolved" }), false);
  assert.equal(hasPolicyFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasPolicyFailure({}), false);
  assert.equal(hasPolicyFailure(undefined), false);

  assert.equal(hasFakeIpFailure({ "anthropics/skills": "fake-ip" }), true);
  assert.equal(hasFakeIpFailure({ "anthropics/skills": "policy" }), false);
  assert.equal(hasFakeIpFailure({ "anthropics/skills": "unresolved" }), false);
  assert.equal(hasFakeIpFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasFakeIpFailure({}), false);
  assert.equal(hasFakeIpFailure(undefined), false);

  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "unresolved" }), true);
  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "fake-ip" }), false);
  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "policy" }), false);
  assert.equal(hasUnresolvedFailure({ "anthropics/skills": "network" }), false);
  assert.equal(hasUnresolvedFailure({}), false);
  assert.equal(hasUnresolvedFailure(undefined), false);
});
