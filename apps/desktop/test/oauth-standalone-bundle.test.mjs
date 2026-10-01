import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = require("esbuild");

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("standalone Desktop bundle loads real ChatGPT and legacy Meta OAuth without repository modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-oauth-bundle-"));
  try {
    const output = join(directory, "oauth.mjs");
    const result = await build({
      entryPoints: [resolve(root, "apps/desktop/electron/main/oauth.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      metafile: true,
      banner: { js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);' },
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.some((path) => path.endsWith("auth/oauth/openai-chatgpt.js")));
    assert.ok(inputs.some((path) => path.endsWith("auth/oauth/meta.js")));
    // All non-builtin dependencies must be inside this standalone artifact.
    const { isBuiltin } = await import("node:module");
    for (const artifact of Object.values(result.metafile.outputs)) {
      for (const dependency of artifact.imports) {
        // ws probes these optional accelerators under try/catch. Neither is
        // shipped into the isolated directory; its JavaScript path must work.
        const optionalNative = ["bufferutil", "utf-8-validate"].includes(dependency.path);
        assert.ok(!dependency.external || isBuiltin(dependency.path) || optionalNative, dependency.path);
      }
    }
    await writeFile(join(directory, "exercise.mjs"), exercise);
    const { stdout } = await promisify(execFile)(process.execPath, ["exercise.mjs"], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, NODE_PATH: "" },
      timeout: 30_000,
    });
    assert.equal(stdout.trim(), "standalone OAuth flows passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Only I/O is replaced. The production VendorOAuth, Models implementation,
// static registration, flow loading, PKCE, callback validation and token
// conversion all execute from the standalone build in a fresh process.
const exercise = String.raw`
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
http.Server.prototype.listen = function () { throw new Error("mock callback port unavailable"); };
syncBuiltinESMExports();
const { VendorOAuth, secretRefForProviderOauth } = await import("./oauth.mjs");
const secrets = new Map();
const providers = new Map([["legacy", { id: "legacy", vendorKey: "openai-codex", authKind: "oauth" }]]);
const legacy = JSON.stringify({ type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: 4102444800000 });
secrets.set(secretRefForProviderOauth("legacy"), legacy);
const logs = [];
const hostIds = [];
let count = 0;
let exchanges = 0;
let oauth;
let complete;
let failed;
let authorization;
const json = (data) => new Response(JSON.stringify(data), { status: 200 });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === "https://auth.openai.com/api/accounts/oauth/token") {
    assert.equal(init.body.get("grant_type"), "authorization_code");
    assert.equal(init.body.get("client_id"), "test-issued-client");
    assert.equal(init.body.get("code"), "test-code");
    assert.ok(init.body.get("code_verifier"));
    exchanges++;
    return json({ access_token: "new-access-" + exchanges, refresh_token: "new-refresh-" + exchanges,
      id_token: "test-id-token", expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
  }
  if (url === "https://auth.meta.com/oidc/device/authorization/") return json({
    device_code: "test-device", user_code: "TEST-CODE", verification_uri_complete: "https://auth.meta.com/device/verify", interval: 0.001, expires_in: 30 });
  if (url === "https://auth.meta.com/oidc/device/token/") return json({ access_token: "test-meta-identity" });
  if (url === "https://api.meta.ai/muse-code/key") return json({ api_key: "test-meta-key" });
  throw new Error("Unexpected mocked network operation");
};
const deps = {
  call: async (method, params = {}) => {
    if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) ?? null };
    if (method === "secrets.set") { secrets.set(params.secretRef, params.value); return {}; }
    if (method === "providers.list") return { providers: [...providers.values()].map((row) => ({ ...row, hasOauth: secrets.has(secretRefForProviderOauth(row.id)) })) };
    if (method === "providers.create") { const row = { ...params, id: "new-" + ++count }; providers.set(row.id, row); return { provider: row }; }
    if (method === "providers.update") { Object.assign(providers.get(params.id), params); return {}; }
    if (method === "providers.delete") { providers.delete(params.id); secrets.delete(secretRefForProviderOauth(params.id)); return {}; }
    throw new Error("Unexpected host operation");
  },
  log: (...args) => logs.push(args),
  openExternal: async (url) => {
    if (!url.startsWith("https://auth.openai.com/")) return;
    authorization = new URL(url);
    hostIds.push(authorization.searchParams.get("ext_agent_host_id"));
  },
  emit: (event) => {
    if (event.kind === "error") failed(new Error(event.message));
    if (event.kind === "done") complete(event.providerId);
    if (event.kind === "prompt") {
      const callback = new URL("http://127.0.0.1:1455/auth/callback");
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("client_id", "test-issued-client");
      oauth.respond({ loginId: event.loginId, promptId: event.request.promptId, value: callback.href });
    }
  },
};
oauth = new VendorOAuth(deps);
await oauth.listVendors();
assert.equal(secrets.size, 1, "listing must not generate identity");
async function login(vendor) {
  const result = new Promise((resolve, reject) => { complete = resolve; failed = reject; });
  await oauth.start(vendor);
  return result;
}
const first = await login("openai");
oauth = new VendorOAuth(deps);
const second = await login("openai");
assert.notEqual(first, second);
assert.equal(exchanges, 2);
assert.equal(hostIds[0], hostIds[1]);
assert.match(hostIds[0], /^urn:uuid:[0-9a-f-]{36}$/);
assert.deepEqual(await oauth.resolveAuth(first), { apiKey: "new-access-1" });
assert.deepEqual(await oauth.resolveAuth(second), { apiKey: "new-access-2" });
assert.equal(secrets.get(secretRefForProviderOauth("legacy")), legacy);
assert.equal(providers.get("legacy").vendorKey, "openai-codex");
await oauth.deleteAccount(first);
assert.deepEqual(await oauth.resolveAuth(second), { apiKey: "new-access-2" });
const meta = await login("meta");
assert.deepEqual(await oauth.resolveAuth(meta), { apiKey: "test-meta-key" });
assert.equal(JSON.stringify(logs).includes(hostIds[0].slice(9)), false);
console.log("standalone OAuth flows passed");
`;
