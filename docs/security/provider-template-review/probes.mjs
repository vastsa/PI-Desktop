import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { Host } from "../../../scripts/e2e/host.mjs";

const root = new URL("../../../", import.meta.url);
register(new URL("apps/desktop/test/helpers/ts-import-hooks.mjs", root));
const { runProviderTemplateOAuth } = await import(new URL("apps/desktop/electron/main/provider-template-oauth.ts", root));
const config = { flow: "authorization_code", clientId: "public-client", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token" };

test("an unauthenticated first callback consumes login without exchanging a token", async () => {
  let exchanges = 0, callbackUrl;
  await assert.rejects(runProviderTemplateOAuth(config, { operation: "login", providerId: "cloud" }, {
    signal: new AbortController().signal, notify() {},
    network: { async assertUrl() {}, async fetch() { exchanges++; throw new Error("must not exchange"); } },
    async openExternal(url) {
      callbackUrl = new URL(new URL(url).searchParams.get("redirect_uri"));
      const invalid = new URL(callbackUrl);
      invalid.searchParams.set("code", "synthetic-untrusted-code");
      invalid.searchParams.set("state", "wrong-state");
      const response = await fetch(invalid);
      assert.equal(response.status, 200);
      await response.text();
    },
  }), error => error.code === "OAUTH_STATE" && !String(error).includes("synthetic"));
  assert.equal(exchanges, 0);
  await assert.rejects(fetch(callbackUrl));
});

test("refresh redirects never replay synthetic credentials to another endpoint", async () => {
  const requests = [];
  await assert.rejects(runProviderTemplateOAuth(config, {
    operation: "refresh", providerId: "cloud", credential: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" },
  }, {
    signal: new AbortController().signal, notify() {}, openExternal() {},
    network: { async assertUrl() {}, async fetch(url, init) {
      requests.push({ url, redirect: init.redirect });
      assert.equal(new URLSearchParams(init.body).get("refresh_token"), "synthetic-refresh");
      return new Response(null, { status: 307, headers: { location: "https://other.example.com/token" } });
    } },
  }), error => error.code === "OAUTH_HTTP" && !String(error).includes("synthetic"));
  assert.deepEqual(requests, [{ url: config.tokenUrl, redirect: "manual" }]);
});

test("failed cleanup leaves an enabled account and OAuth grant despite uninstall success", { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "template-uninstall-audit-"));
  const data = join(dir, "data"), plugin = join(dir, "plugin");
  // Pin the candidate binary rather than falling back to another checkout.
  const binary = process.env.PI_DESKTOP_HOST_BIN ?? fileURLToPath(new URL(
    process.platform === "win32" ? "target/debug/pi-desktop-host-core.exe" : "target/debug/pi-desktop-host-core", root,
  ));
  const host = new Host(binary, data, { quiet: true });
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(plugin);
  const id = "fixture.cleanup_audit";
  await writeFile(join(plugin, "main.cjs"), "module.exports={onProviderOAuth(){}};");
  await writeFile(join(plugin, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: "Cleanup audit", version: "1.0.0", main: "main.cjs",
    permissions: ["provider.register", "provider.oauth"],
    contributes: { providerTemplates: [{ version: 1, id: "gateway", name: "Gateway", authKind: "oauth",
      baseUrl: "https://api.example.test/v1", models: [{ id: "chat" }] }] },
  }));
  await host.start();
  await host.call("plugins.loadDev", { path: plugin });
  const { provider } = await host.call("providers.createFromTemplate", { pluginId: id, templateId: "gateway" });
  const oauthRef = `secret:provider:${provider.id}:oauth`;
  const marker = JSON.stringify({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" });
  await host.call("secrets.set", { secretRef: oauthRef, value: marker });
  await host.call("providers.completeTemplateOAuth", { id: provider.id });
  const keyHash = createHash("sha256").update(`secret:provider:${provider.id}:api_key`).digest("hex") + ".bin";
  // Fault injection only: delete(file) fails on a directory in this temporary profile.
  const blocked = join(data, "secrets", keyHash);
  await mkdir(blocked);
  assert.equal((await host.call("plugins.uninstall", { id })).ok, true);
  const residual = (await host.call("providers.get", { id: provider.id })).provider;
  assert.equal(residual.enabled, true);
  assert.equal(residual.hasOauth, true);
  assert.equal((await host.call("secrets.getForRuntime", { secretRef: oauthRef })).value, marker);
  assert.ok(!JSON.stringify(await host.call("plugins.list")).includes(id));
  await rm(blocked, { recursive: true });
  // Before startup orphan cleanup, same-ID registration reuses the retained grant.
  await host.call("plugins.loadDev", { path: plugin });
  const recovered = (await host.call("providers.get", { id: provider.id })).provider;
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.hasOauth, true);
  assert.equal((await host.call("secrets.getForRuntime", { secretRef: oauthRef })).value, marker);
});
