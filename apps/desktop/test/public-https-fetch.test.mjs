import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCodes } from "@pi-desktop/shared";
import {
  createPublicHttpsClient,
  PublicNetworkPolicyError,
} from "../electron/main/public-https-fetch.ts";

function jsonResponse(status, body, location) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === "location" ? location ?? null : null) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("rejects a hostname that resolves to a non-public address", async () => {
  const client = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    lookupImpl: async () => [{ address: "10.0.0.8" }],
  });
  await assert.rejects(
    () => client.request("https://evil.example/catalog.json", "json"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      /non-public address/.test(error.message) &&
      error.reason === "non-public-address" &&
      error.addressKind === "private",
  );
});

test("re-validates each redirect hop and refuses a private Location", async () => {
  const seen = [];
  const client = createPublicHttpsClient({
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === "https://cdn.example/start") {
        return jsonResponse(302, "", "https://127.0.0.1/secret");
      }
      return jsonResponse(200, "leaked");
    },
    lookupImpl: async (host) => {
      if (host === "cdn.example") return [{ address: "1.1.1.1" }];
      return [{ address: "8.8.8.8" }];
    },
  });
  await assert.rejects(
    () => client.request("https://cdn.example/start", "text"),
    PublicNetworkPolicyError,
  );
  assert.deepEqual(seen, ["https://cdn.example/start"]);
});

test("follows a public redirect and returns the final body", async () => {
  const client = createPublicHttpsClient({
    fetchImpl: async (url) => {
      if (url === "https://cdn.example/start") {
        return jsonResponse(302, "", "https://cdn.jsdelivr.net/gh/x/SKILL.md");
      }
      return jsonResponse(200, "# skill\n");
    },
    lookupImpl: async (host) => {
      const table = {
        "cdn.example": "1.1.1.1",
        "cdn.jsdelivr.net": "151.101.1.229",
      };
      return [{ address: table[host] ?? "8.8.8.8" }];
    },
  });
  const body = await client.request("https://cdn.example/start", "text");
  assert.equal(body, "# skill\n");
});

test("does not retry policy failures", async () => {
  let calls = 0;
  const client = createPublicHttpsClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(302, "", "https://127.0.0.1/x");
    },
    lookupImpl: async () => [{ address: "1.1.1.1" }],
  });
  await assert.rejects(
    () => client.request("https://cdn.example/start", "text"),
    PublicNetworkPolicyError,
  );
  assert.equal(calls, 1);
});

test("a policy refusal carries the stable error code the renderer classifies on", async () => {
  // Issue #419: the renderer can only tell a guard refusal from an ordinary
  // failure by this code, because `wrap()` forwards nothing but code and
  // message across the IPC boundary. A fake-IP answer is an address the guard
  // judged, so it keeps the policy code — and now also says which class of
  // address it judged.
  const client = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    lookupImpl: async () => [{ address: "198.18.0.4" }],
  });
  await assert.rejects(
    () => client.request("https://cdn.jsdelivr.net/gh/x/SKILL.md", "text"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED &&
      error.reason === "non-public-address" &&
      error.addressKind === "benchmark" &&
      error.host === "cdn.jsdelivr.net" &&
      /non-public address/.test(error.message) &&
      /benchmark/.test(error.message),
  );
});

test("a syntactic URL refusal carries the same code", async () => {
  const client = createPublicHttpsClient({ fetchImpl: async () => jsonResponse(200, "x") });
  await assert.rejects(
    () => client.assertPublicUrl("http://127.0.0.1/catalog.json"),
    (error) => error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED,
  );
});
