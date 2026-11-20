/**
 * Contract test for where the GitHub connector keeps its credential (ADR
 * github-connector).
 *
 * The token and the account it belongs to live in one host-core secret under
 * a fixed first-party reference. This store is the only code that parses that
 * value, so it is what decides that a damaged or foreign record means "not
 * connected" rather than a half-valid credential reaching a request header.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubConnectorStore } from "../electron/main/github/connector-store.ts";
import { GITHUB_CONNECTOR_SECRET_REF } from "../../../packages/shared/src/secret-refs.ts";

const TOKEN = "gho_storeFixtureToken";

function credential(overrides = {}) {
  return {
    version: 1,
    token: TOKEN,
    kind: "oauth",
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231",
    scopes: ["repo", "read:org"],
    savedAt: "2026-11-20T08:00:00.000Z",
    ...overrides,
  };
}

/** A host secret store stand-in that records every RPC it receives. */
function fakeHost(initial = new Map()) {
  const secrets = initial;
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "secrets.set":
        secrets.set(params.secretRef, params.value);
        return { ok: true };
      case "secrets.getForRuntime":
        return { value: secrets.get(params.secretRef) ?? null };
      case "secrets.delete":
        secrets.delete(params.secretRef);
        return { ok: true };
      default:
        throw new Error(`unexpected host method ${method}`);
    }
  };
  return { call, calls, secrets };
}

function hostHolding(value) {
  return fakeHost(new Map([[GITHUB_CONNECTOR_SECRET_REF, value]]));
}

test("a written credential reads back unchanged, from the fixed reference", async () => {
  const host = fakeHost();
  const store = createGitHubConnectorStore(host.call);

  await store.write(credential());
  assert.deepEqual(await store.read(), credential());

  assert.deepEqual(host.calls.map((entry) => entry.method), [
    "secrets.set",
    "secrets.getForRuntime",
  ]);
  for (const entry of host.calls) {
    assert.equal(entry.params.secretRef, GITHUB_CONNECTOR_SECRET_REF);
  }
  assert.equal(typeof host.calls[0].params.value, "string");
  assert.deepEqual(JSON.parse(host.calls[0].params.value), credential());
});

test("optional account fields may be absent", async () => {
  const host = fakeHost();
  const store = createGitHubConnectorStore(host.call);
  const minimal = credential({ kind: "pat", scopes: [] });
  delete minimal.name;
  delete minimal.avatarUrl;

  await store.write(minimal);
  assert.deepEqual(await store.read(), minimal);
});

test("a missing secret reads as not connected", async () => {
  const store = createGitHubConnectorStore(fakeHost().call);
  assert.equal(await store.read(), null);
});

test("an empty or non-JSON value reads as not connected", async () => {
  assert.equal(await createGitHubConnectorStore(hostHolding("").call).read(), null);
  assert.equal(await createGitHubConnectorStore(hostHolding("not json").call).read(), null);
  // A bare token someone wrote under the reference is not a credential record.
  assert.equal(await createGitHubConnectorStore(hostHolding(TOKEN).call).read(), null);
  assert.equal(await createGitHubConnectorStore(hostHolding("null").call).read(), null);
  assert.equal(await createGitHubConnectorStore(hostHolding("[]").call).read(), null);
});

test("a record from another version reads as not connected", async () => {
  const raw = JSON.stringify(credential({ version: 2 }));
  assert.equal(await createGitHubConnectorStore(hostHolding(raw).call).read(), null);
});

test("a record whose token could not be sent in a header reads as not connected", async () => {
  for (const token of ["", "gho_a b", "gho_a\nx-injected: 1", 42, "a".repeat(4097)]) {
    const raw = JSON.stringify(credential({ token }));
    assert.equal(
      await createGitHubConnectorStore(hostHolding(raw).call).read(),
      null,
      `token ${JSON.stringify(token).slice(0, 24)}`,
    );
  }
});

test("a record with a malformed account or kind reads as not connected", async () => {
  for (const overrides of [
    { kind: "app" },
    { login: "" },
    { login: 7 },
    { scopes: "repo" },
    { scopes: ["repo", 3] },
    { savedAt: 5 },
  ]) {
    const raw = JSON.stringify(credential(overrides));
    assert.equal(
      await createGitHubConnectorStore(hostHolding(raw).call).read(),
      null,
      JSON.stringify(overrides),
    );
  }
});

test("unknown fields in a stored record are not handed on", async () => {
  const raw = JSON.stringify({ ...credential(), refreshToken: "ghr_extra", name: 9 });
  const read = await createGitHubConnectorStore(hostHolding(raw).call).read();
  const expected = credential();
  delete expected.name;
  assert.deepEqual(read, expected);
});

test("clear deletes the fixed reference", async () => {
  const host = hostHolding(JSON.stringify(credential()));
  const store = createGitHubConnectorStore(host.call);

  await store.clear();

  assert.deepEqual(host.calls, [
    { method: "secrets.delete", params: { secretRef: GITHUB_CONNECTOR_SECRET_REF } },
  ]);
  assert.equal(await store.read(), null);
});

test("a host failure is reported, never mistaken for not connected", async () => {
  const failing = async () => {
    throw Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  };
  const store = createGitHubConnectorStore(failing);

  await assert.rejects(store.read(), /host unavailable/);
  await assert.rejects(store.write(credential()), /host unavailable/);
  await assert.rejects(store.clear(), /host unavailable/);
});

test("write refuses a credential it could not read back", async () => {
  const host = fakeHost();
  const store = createGitHubConnectorStore(host.call);

  await assert.rejects(store.write(credential({ token: "gho_a\nb" })), (error) => {
    assert.equal(error.errorCode, "GITHUB_INVALID_TOKEN");
    assert.equal(String(error.message).includes("gho_a"), false);
    return true;
  });
  assert.equal(host.calls.length, 0);
});
