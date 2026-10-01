import assert from "node:assert/strict";
import test from "node:test";
import { createInstallationIdentity } from "../electron/main/installation-identity.ts";

const id = "12345678-1234-4234-8234-123456789abc";
const ref = "secret:installation:oauth-device-id";

function host(initial) {
  let value = initial;
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    await new Promise((resolve) => setImmediate(resolve));
    if (method === "secrets.getForRuntime") return { value };
    assert.equal(method, "secrets.set");
    value = params.value;
  };
  return { call, calls };
}

test("identity is lazy, single-flight, persisted before use, and stable after service restart", async () => {
  const storage = host(null);
  let generated = 0;
  const get = createInstallationIdentity(storage.call, () => { generated++; return id; });
  assert.equal(storage.calls.length, 0);
  const requests = Array.from({ length: 32 }, () => get());
  assert.ok(requests.every((pending) => pending === requests[0]));
  assert.deepEqual(await Promise.all(requests), Array(32).fill(id));
  assert.equal(generated, 1);
  assert.deepEqual(storage.calls, [
    { method: "secrets.getForRuntime", params: { secretRef: ref } },
    { method: "secrets.set", params: { secretRef: ref, value: id } },
  ]);
  assert.equal(await get(), id);
  assert.equal(storage.calls.length, 2);
  const restarted = createInstallationIdentity(storage.call, () => assert.fail("must reuse persisted identity"));
  assert.equal(await restarted(), id);
});

for (const failingMethod of ["secrets.getForRuntime", "secrets.set"]) {
  test(`identity ${failingMethod} failure is redacted, shared, and retryable`, async () => {
    const storage = host(null);
    let fail = true;
    const get = createInstallationIdentity(async (method, params) => {
      if (fail && method === failingMethod) throw new Error(`backend exposed ${id}`);
      return storage.call(method, params);
    }, () => id);
    const results = await Promise.allSettled([get(), get(), get()]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.message, "Could not load or persist the OAuth installation identity");
      assert.equal(result.reason.cause, undefined);
    }
    fail = false;
    assert.equal(await get(), id);
  });
}

test("an invalid stored identity fails closed without overwriting it", async () => {
  const storage = host("invalid-private-value");
  await assert.rejects(createInstallationIdentity(storage.call)(), /Could not load or persist/);
  assert.equal(storage.calls.length, 1);
});

test("a generated non-UUID cannot be persisted", async () => {
  const storage = host(null);
  await assert.rejects(createInstallationIdentity(storage.call, () => "not-a-uuid")(), /Could not load or persist/);
  assert.equal(storage.calls.length, 1);
});
