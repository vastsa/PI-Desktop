import assert from "node:assert/strict";
import { register } from "node:module";
import { createServer } from "node:http";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { platformTokenUsage } = await import("../electron/main/services/platform-account-service.ts");
const provider = {
  id: "p", enabled: true, vendorKey: "ai-aggregation-platform",
  baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key_and_base_url",
};

function hostFor(row = provider) {
  const calls = [];
  return {
    calls,
    async call(method) {
      calls.push(method);
      if (method === "providers.get") return { provider: row };
      if (method === "providers.getSecret") return { value: "test-only-token" };
      throw new Error(`Unexpected ${method}`);
    },
  };
}

test("token allowance uses the read-only route, dynamic unit and no wallet authority", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/status"
      ? { success: true, data: { quota_per_unit: 500000 } }
      : { code: true, data: { total_granted: 1000000, total_used: 250000, total_available: 750000, unlimited_quota: false, expires_at: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const result = await platformTokenUsage(hostFor(), "p", async (url, init) => {
    assert.equal(new URL(url).origin, "https://ai.yykkj.com");
    assert.equal(init.redirect, "error");
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  });
  assert.deepEqual(result, { totalGranted: 2, totalUsed: 0.5, totalAvailable: 1.5, unlimited: false, expiresAt: 0, unit: "USD" });
  assert.equal(requests.find((r) => r.path === "/api/status").auth, undefined);
  assert.equal(requests.find((r) => r.path === "/api/usage/token/").auth, "Bearer test-only-token");
  assert.equal(requests.length, 2);
});

test("foreign providers never read a secret or call HTTP", async () => {
  const host = hostFor({ ...provider, vendorKey: "openai", baseUrl: "https://api.openai.com/v1" });
  await assert.rejects(platformTokenUsage(host, "p", async () => { throw new Error("Network must not run"); }), /only supports/);
  assert.deepEqual(host.calls, ["providers.get"]);
});

test("missing unit stays raw quota, unlimited is retained, and API failures are not zero balance", async () => {
  const usage = { total_granted: 0, total_used: 0, total_available: 0, unlimited_quota: true };
  const reply = (data) => async (url) => new Response(JSON.stringify(url.endsWith("/api/status") ? { data: {} } : data));
  const result = await platformTokenUsage(hostFor(), "p", reply({ code: true, data: usage }));
  assert.equal(result.unlimited, true);
  assert.equal(result.unit, "quota");
  await assert.rejects(platformTokenUsage(hostFor(), "p", reply({ code: false, message: "bad token" })), /did not return/);
  await assert.rejects(platformTokenUsage(hostFor(), "p", reply({ code: true, data: { ...usage, total_available: -1 } })), /Invalid platform quota/);
});
