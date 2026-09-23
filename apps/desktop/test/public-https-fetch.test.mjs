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

test("a user-supplied endpoint may resolve to the machine or the LAN", async () => {
  // The address belongs to whoever typed the endpoint in, so loopback, RFC1918
  // and link-local are reachable there. The same address on the default
  // (third-party) origin stays refused, which is the behaviour nothing here
  // changes.
  const client = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    lookupImpl: async () => [{ address: "10.0.0.8" }],
  });
  await assert.rejects(
    () => client.request("https://nas.example/catalog.json", "json"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "non-public-address" &&
      error.addressKind === "private",
  );
  assert.deepEqual(await client.request("https://nas.example/catalog.json", "json", "user"), {
    ok: true,
  });
  await client.assertPublicUrl("https://nas.local:8443/catalog.json", "user");

  const loopback = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    lookupImpl: async () => [{ address: "127.0.0.1" }],
  });
  await loopback.assertPublicUrl("https://local.example/catalog.json", "user");
});

test("a user-supplied endpoint still may not name cloud metadata", async () => {
  // A metadata service answers with the host's own credentials, so no settings
  // field may spell one — not even the field the user fills in themselves.
  const byHost = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [{ address: "10.0.0.8" }],
  });
  await assert.rejects(
    () => byHost.assertPublicUrl("https://169.254.169.254/latest/meta-data", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError && error.reason === "url-syntax",
  );
  await assert.rejects(
    () => byHost.assertPublicUrl("https://metadata.google.internal/computeMetadata", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError && error.reason === "url-syntax",
  );

  // …and not by resolution either: the address the user's own hostname answers
  // with is still judged, and a metadata address fails that judgement.
  const byAddress = createPublicHttpsClient({
    fetchImpl: async () => {
      throw new Error("a refused request must never reach the network");
    },
    lookupImpl: async () => [{ address: "169.254.169.254" }],
  });
  await assert.rejects(
    () => byAddress.assertPublicUrl("https://internal.example/catalog.json", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "non-public-address" &&
      error.address === "169.254.169.254" &&
      error.addressKind === "link-local",
  );
});

test("plaintext needs the stored opt-in, and only for a user-supplied endpoint", async () => {
  const strict = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, "catalog"),
    lookupImpl: async () => [{ address: "192.168.1.5" }],
  });
  await assert.rejects(
    () => strict.request("http://192.168.1.5:8080/catalog.json", "text", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "url-syntax" &&
      error.errorCode === ErrorCodes.NETWORK_POLICY_BLOCKED,
  );

  const permissive = createPublicHttpsClient({
    fetchImpl: async () => jsonResponse(200, "catalog"),
    lookupImpl: async () => [{ address: "192.168.1.5" }],
    allowInsecureUserEndpoints: true,
  });
  assert.equal(
    await permissive.request("http://192.168.1.5:8080/catalog.json", "text", "user"),
    "catalog",
  );
  // The opt-in is exactly that: it buys the plaintext hop to the user's own
  // endpoint, and nothing on the third-party origin.
  await assert.rejects(
    () => permissive.request("http://192.168.1.5:8080/catalog.json", "text"),
    (error) => error instanceof PublicNetworkPolicyError && error.reason === "url-syntax",
  );
});

test("only the first hop is the user's: a redirect is judged as third-party", async () => {
  const seen = [];
  const client = createPublicHttpsClient({
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === "https://start.example/start.json") {
        return jsonResponse(302, "", "https://internal.example/next.json");
      }
      return jsonResponse(200, { ok: true });
    },
    lookupImpl: async () => [{ address: "127.0.0.1" }],
  });
  // The first hop is the endpoint the user typed, so its loopback answer is
  // theirs; the redirect target is an address the app learned from that
  // endpoint's answer, so the same answer is a refusal there.
  await assert.rejects(
    () => client.request("https://start.example/start.json", "json", "user"),
    (error) =>
      error instanceof PublicNetworkPolicyError &&
      error.reason === "non-public-address" &&
      error.host === "internal.example" &&
      error.addressKind === "loopback",
  );
  assert.deepEqual(seen, ["https://start.example/start.json"]);
});
