import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCodes } from "@pi-desktop/shared";
import { createPublicHttpsClient } from "../electron/main/public-https-fetch.ts";
import { createSkillMarketAggregator } from "../electron/main/skill-market-scan.ts";

/**
 * Regression cover for the remaining half of issue #419.
 *
 * The public-network guard classifies the target host with a *local* resolver
 * while the request itself would travel through the configured proxy (ADR 0177,
 * ADR 0243), so a proxied or TUN user's local resolver can answer with a fake
 * address — Clash fake-IP in `198.18.0.0/15` — or with nothing at all. Only the
 * first is a verdict on an address. Collapsing both into one `policy` bucket let
 * the app tell users their catalog sources "were blocked by the app's address
 * check" when no address had ever been judged: that is the exact line the
 * reporter quoted.
 *
 * Nothing here changes *whether* the guard blocks. Every case below is still
 * refused, and the last test pins that. What is pinned is what the app says about
 * it — which host, and which of the two causes.
 *
 * Every client here wires no route resolver, so every case below keeps the
 * strict pre-ADR-0272 verdict by construction; the route-aware policy has its
 * own cover in `public-https-fetch-route.test.mjs`.
 */

const composio = {
  id: "composio-awesome",
  name: "ComposioHQ/awesome-claude-skills",
  url: "https://github.com/ComposioHQ/awesome-claude-skills",
};

/** The first hop of a GitHub scan, which is the host the guard classifies first. */
const SCAN_HOST = "api.github.com";

test("a resolver with no answer is not reported as an address-check refusal", async () => {
  // An empty answer is what the panel used to explain with
  // `settings.sklm.remoteErrorPolicy` ("blocked by the app's address check"),
  // even though nothing was classified.
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [],
  });
  const aggregator = createSkillMarketAggregator(client.request);
  const result = await aggregator.search("", [composio]);

  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.failedSources, [composio.name]);
  assert.equal(result.failureKinds[composio.name], "unresolved");
  assert.deepEqual(result.failureDetails[composio.name], {
    kind: "unresolved",
    reason: "resolve-failed",
    host: SCAN_HOST,
    // This client wires no route resolver, and an unreadable route is never
    // permission: it keeps the strict verdict (ADR 0272).
    route: "unknown",
  });
});

test("a resolver that throws is unresolved too, and that one is retried", async () => {
  // Node's resolver throws (ENOTFOUND, EAI_AGAIN, a stub that refuses) instead
  // of returning an empty answer, so this is the shape a blocked local resolver
  // actually produces.
  let lookups = 0;
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => {
      lookups += 1;
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${SCAN_HOST}`), { code: "ENOTFOUND" });
    },
  });
  const aggregator = createSkillMarketAggregator(client.request);
  const result = await aggregator.search("", [composio]);

  assert.equal(result.failureKinds[composio.name], "unresolved");
  assert.equal(result.failureDetails[composio.name].reason, "resolve-failed");
  // A resolver that answered nothing is worth retrying — every attempt
  // re-classifies from scratch. A judged address is not, and never was.
  assert.equal(lookups, 3);
});

test("an unreadable route still refuses a TUN fake-IP, and names what it refused", async () => {
  // Clash's default fake-IP range on a client that wires no route resolver at
  // all. The address verdict still lands on the address this app would dial, so
  // it stays a refusal; with a proxied route reported for the hop the same
  // answer is the resolver's artifact and is tolerated (ADR 0272). Either way
  // the refusal carries the host, the reason, the address, its class, and the
  // route it was judged on — and it is its own cause rather than the same
  // finding as a real private target — instead of the one word "private" that
  // fit none of the benchmark/CGNAT/loopback cases.
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [{ address: "198.18.0.4" }],
  });
  const aggregator = createSkillMarketAggregator(client.request);
  const result = await aggregator.search("", [composio]);

  assert.equal(result.failureKinds[composio.name], "fake-ip");
  assert.deepEqual(result.failureDetails[composio.name], {
    kind: "fake-ip",
    reason: "non-public-address",
    host: SCAN_HOST,
    address: "198.18.0.4",
    addressKind: "benchmark",
    route: "unknown",
  });
});

test("a real private target and a fake-IP are told apart in the record", async () => {
  // Both are refused. Only the class says whether a resolver artifact or an
  // actual RFC1918 destination produced the answer — which is the difference
  // between "fix your proxy" and "this source points inside your network".
  const refusedKind = async (address) => {
    const client = createPublicHttpsClient({
      fetchImpl: async () => {
        throw new Error("a refused request must never reach the network");
      },
      lookupImpl: async () => [{ address }],
    });
    try {
      await client.assertPublicUrl(`https://${SCAN_HOST}/x`);
      return assert.fail(`expected ${address} to be refused`);
    } catch (error) {
      return error.addressKind;
    }
  };
  assert.equal(await refusedKind("198.18.0.4"), "benchmark");
  assert.equal(await refusedKind("10.0.0.8"), "private");
  assert.equal(await refusedKind("127.0.0.1"), "loopback");
});

test("the install sheet's code separates the two causes, and both stay refusals", async () => {
  const unresolved = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("no network");
    },
    lookupImpl: async () => [],
  });
  await assert.rejects(
    () => unresolved.assertPublicUrl(`https://${SCAN_HOST}/x`),
    (error) =>
      error.errorCode === ErrorCodes.NETWORK_RESOLVE_FAILED &&
      error.reason === "resolve-failed" &&
      error.host === SCAN_HOST,
  );

  const fakeIp = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("no network");
    },
    lookupImpl: async () => [{ address: "198.18.0.4" }],
  });
  await assert.rejects(
    () => fakeIp.assertPublicUrl(`https://${SCAN_HOST}/x`),
    (error) =>
      error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED &&
      error.reason === "non-public-address" &&
      error.addressKind === "benchmark",
  );

  // A syntactic rejection is a verdict too, and keeps the policy code.
  const syntax = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("no network");
    },
  });
  await assert.rejects(
    () => syntax.assertPublicUrl("https://127.0.0.1/catalog.json"),
    (error) =>
      error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED && error.reason === "url-syntax",
  );

  assert.notEqual(ErrorCodes.NETWORK_RESOLVE_FAILED, ErrorCodes.NETWORK_POLICY_BLOCKED);
});

test("a document URL the syntactic guard refuses is a refusal, not a dead host", async () => {
  // This branch used to throw a bare `Error`, so the install sheet reported an
  // internal-policy rejection as "the document was unreachable".
  const aggregator = createSkillMarketAggregator(async () => {
    throw new Error("must not fetch");
  });
  await assert.rejects(
    () => aggregator.fetchEntryDocument({ id: "x", name: "x", url: "https://10.0.0.8/x.md" }),
    (error) => error.name === "PublicNetworkPolicyError" && error.reason === "url-syntax",
  );
});

test("all seven built-in sources stay refused under a TUN resolver, never admitted", async () => {
  // The guard's decision is unchanged by this fix: this is the reporter's
  // environment, and the request still must not leave the process.
  const sources = [
    { id: "anthropics-skills", name: "anthropics/skills", url: "https://github.com/anthropics/skills" },
    {
      id: "composio-awesome",
      name: "ComposioHQ/awesome-claude-skills",
      url: "https://github.com/ComposioHQ/awesome-claude-skills",
    },
  ];
  let fetched = 0;
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      fetched += 1;
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    },
    lookupImpl: async () => [{ address: "198.18.0.4" }],
  });
  const aggregator = createSkillMarketAggregator(client.request);
  const result = await aggregator.search("", sources);

  assert.equal(fetched, 0, "a fake-IP answer must never be fetched through");
  assert.deepEqual(result.entries, []);
  assert.deepEqual([...result.failedSources].sort(), sources.map((source) => source.name).sort());
  for (const source of sources) {
    assert.equal(result.failureKinds[source.name], "fake-ip");
  }
});

/**
 * The fake-IP case, which the coordinator's lead puts at the centre of #419.
 *
 * Clash, Mihomo, sing-box and Surge all ship `198.18.0.0/15` — RFC 2544's
 * benchmark range — as their default fake-IP pool. `classifyIpLiteral` is right
 * to call that non-public, and the guard must keep refusing it. But that address
 * is the *proxy's* placeholder for the name, not the target's own address, so
 * collapsing it into the same finding as a real `10.0.0.0/8` target tells the
 * user their catalog source is bad when the thing to change is their proxy mode.
 */

/** The market's verdict for one literal, through the real client and aggregator. */
async function marketKindForAddress(address) {
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [{ address }],
  });
  return createSkillMarketAggregator(client.request).search("", [composio]);
}

test("a proxy fake-IP is its own cause, not the same finding as a private target", async () => {
  // Both halves of Clash's default pool, so the range and not one address is
  // what gets pinned.
  assert.equal((await marketKindForAddress("198.18.0.1")).failureKinds[composio.name], "fake-ip");
  assert.equal(
    (await marketKindForAddress("198.19.255.254")).failureKinds[composio.name],
    "fake-ip",
  );
  // A real private or loopback target is a different finding, with different
  // advice: that one is about the destination, not about the proxy.
  assert.equal((await marketKindForAddress("127.0.0.1")).failureKinds[composio.name], "policy");
  assert.equal((await marketKindForAddress("10.1.2.3")).failureKinds[composio.name], "policy");
  assert.equal((await marketKindForAddress("192.168.1.10")).failureKinds[composio.name], "policy");
});

test("the fake-IP cause never admits the request", async () => {
  // The whole point of a separate cause is the explanation, never the outcome.
  // This is the assertion that would fail first if the split were implemented as
  // an exemption instead of a label.
  let fetched = 0;
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      fetched += 1;
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "",
      };
    },
    lookupImpl: async () => [{ address: "198.18.0.1" }],
  });
  const result = await createSkillMarketAggregator(client.request).search("", [composio]);
  assert.equal(fetched, 0, "a fake-IP answer must never be fetched through");
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.failedSources, [composio.name]);
  assert.equal(result.failureKinds[composio.name], "fake-ip");
});

test("the refusal names the host and the address, not only the source label", async () => {
  // "Catalog sources were blocked by the app's address check" named nothing. The
  // host and the address it was resolved to are the whole diagnosis: one glance
  // at `198.18.0.1` is what tells a user their proxy is in fake-IP mode.
  const result = await marketKindForAddress("198.18.0.1");
  assert.deepEqual(result.failureDetails[composio.name], {
    kind: "fake-ip",
    reason: "non-public-address",
    host: SCAN_HOST,
    address: "198.18.0.1",
    addressKind: "benchmark",
    route: "unknown",
  });
  const privateTarget = await marketKindForAddress("10.1.2.3");
  assert.equal(privateTarget.failureDetails[composio.name].address, "10.1.2.3");
  assert.equal(privateTarget.failureDetails[composio.name].addressKind, "private");
});

test("a resolver that answered nothing is not a fake-IP and not a verdict", async () => {
  // The three cases the lead asks to keep apart, asserted side by side so a
  // future refactor cannot merge two of them again.
  const judgedFake = await marketKindForAddress("198.18.0.1");
  assert.equal(judgedFake.failureKinds[composio.name], "fake-ip");

  const judgedPrivate = await marketKindForAddress("10.1.2.3");
  assert.equal(judgedPrivate.failureKinds[composio.name], "policy");

  const silent = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [],
  });
  const unanswered = await createSkillMarketAggregator(silent.request).search("", [composio]);
  assert.equal(unanswered.failureKinds[composio.name], "unresolved");

  const syntactic = createSkillMarketAggregator(async () => {
    throw new Error("a syntactically refused source is never requested");
  });
  const refused = await syntactic.search("", [
    { id: "x", name: "x/private", url: "https://10.0.0.8/catalog.json" },
  ]);
  assert.equal(refused.failureKinds["x/private"], "policy");
  assert.equal(refused.failureDetails["x/private"].reason, "url-syntax");
});
