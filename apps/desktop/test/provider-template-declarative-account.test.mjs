import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { setImmediate as immediate } from "node:timers/promises";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { VendorOAuth, secretRefForProviderOauth } = await import("../electron/main/oauth.ts");
const { validateManifest } = await import("@pi-desktop/plugin-sdk");

const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const access = "private-access-token", refresh = "private-refresh-token", fresh = "private-fresh-access-token";
const authorizationCode = "private-one-use-code", deviceCode = "private-device-code";

function fixture(t, flow = "authorization_code") {
  const pluginId = "fixture.declarative", templateId = "cloud";
  const chooser = `plugin-template:${pluginId}:${templateId}`;
  const oauthConfig = { flow, clientId: "public-client", tokenUrl: "https://auth.example.test/token",
    ...(flow === "authorization_code" ? { authorizationUrl: "https://auth.example.test/authorize", redirectPath: "/oauth/complete", scopes: ["read", "profile"] }
      : { deviceAuthorizationUrl: "https://auth.example.test/device" }) };
  const template = { version: 1, id: templateId, name: "Declarative Cloud", authKind: "oauth", baseUrl: "https://api.example.test/v1", models: [{ id: "chat" }], oauth: oauthConfig };
  const manifest = { schemaVersion: 1, id: pluginId, name: "Declarative fixture", version: "1.0.0", main: "main.js",
    permissions: ["provider.register"], contributes: { providerTemplates: [template] } };
  assert.equal(validateManifest(manifest).ok, true, "no provider.oauth custom grant is required");
  const source = { pluginId, runtimeId: "runtime-1", contributionId: templateId, providerId: chooser, templateId,
    pluginName: manifest.name, name: template.name, isSubscription: false, oauth: oauthConfig };
  const rows = new Map(), secrets = new Map(), events = [], calls = [], tokenBodies = [], checkedUrls = [], browsers = [];
  const owner = new AbortController(), terminal = new Map(), completed = new Map();
  const deviceShown = Promise.withResolvers();
  let sequence = 0, loaded = true, customCalls = 0, signalCalls = 0, held;
  const host = { call: async (method, p = {}) => {
    calls.push({ method, ...p });
    const project = row => row && ({ ...row, hasOauth: secrets.has(secretRefForProviderOauth(row.id)) });
    if (method === "providers.list") return { providers: [...rows.values()].map(project) };
    if (method === "providers.get") return { provider: project(rows.get(p.id)) };
    if (method === "providers.createFromTemplate") {
      assert.deepEqual(p, { pluginId, templateId });
      const row = { id: `native-account-${++sequence}`, name: template.name, ownerPluginId: pluginId, pluginTemplateId: templateId, pluginTemplateVersion: 1,
        enabled: false, authKind: "oauth", baseUrl: template.baseUrl, apiStyle: "chat_completions", vendorKey: "custom",
        models: [{ id: "chat", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: "off", availableForSubagents: true }] };
      rows.set(row.id, row);
      return { provider: project(row) };
    }
    if (method === "secrets.set") { assert.ok(rows.has(p.secretRef.split(":")[2])); secrets.set(p.secretRef, p.value); return { ok: true }; }
    if (method === "secrets.getForRuntime") return { value: secrets.get(p.secretRef) };
    if (method === "secrets.delete") { secrets.delete(p.secretRef); return { ok: true }; }
    if (method === "providers.completeTemplateOAuth") {
      assert.equal(rows.get(p.id)?.enabled, false);
      const credential = JSON.parse(secrets.get(secretRefForProviderOauth(p.id)));
      assert.equal(credential.accessToken, access);
      assert.equal(credential.refreshToken, refresh);
      rows.get(p.id).enabled = true;
      return { provider: project(rows.get(p.id)) };
    }
    if (method === "providers.delete") { rows.delete(p.id); secrets.delete(secretRefForProviderOauth(p.id)); return { ok: true }; }
    throw new Error(`Unexpected Host RPC: ${method}`);
  } };
  const bridge = {
    listOAuthProviders: () => loaded ? [source] : [],
    providerOAuthSignal(provider) { assert.equal(provider, source); signalCalls++; return owner.signal; },
    invokeProviderOAuth() { customCalls++; throw new Error("Declarative OAuth must never call custom plugin code"); },
  };
  const oauth = new VendorOAuth({ call: host.call, getPluginOAuthBridge: () => bridge,
    providerTemplateNetwork: {
      async assertUrl(url) { assert.equal(new URL(url).origin, "https://auth.example.test"); checkedUrls.push(url); },
      async fetch(url, init) {
        assert.equal(new URL(url).origin, "https://auth.example.test");
        assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("client_id"), oauthConfig.clientId); assert.equal(body.has("client_secret"), false);
        if (url === oauthConfig.deviceAuthorizationUrl) return json({ device_code: deviceCode, user_code: "SHOW-CODE", verification_uri: "https://auth.example.test/activate", interval: 1, expires_in: 120 });
        assert.equal(url, oauthConfig.tokenUrl);
        tokenBodies.push(body);
        if (body.get("grant_type") === "authorization_code") {
          const browser = browsers.at(-1);
          assert.equal(body.get("code"), authorizationCode);
          assert.equal(body.get("redirect_uri"), browser.searchParams.get("redirect_uri"));
          assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), browser.searchParams.get("code_challenge"));
        } else if (body.get("grant_type") === "refresh_token") {
          assert.equal(body.get("refresh_token"), refresh);
        } else {
          assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
          assert.equal(body.get("device_code"), deviceCode);
        }
        if (held) { held.started.resolve(init.signal); return held.response.promise; }
        return json({ access_token: body.get("grant_type") === "refresh_token" ? fresh : access, token_type: "Bearer", expires_in: 3600,
          ...(body.get("grant_type") === "refresh_token" ? {} : { refresh_token: refresh }) });
      },
    },
    async openExternal(url) {
      const browser = new URL(url); browsers.push(browser);
      assert.equal(browser.origin, "https://auth.example.test");
      assert.equal(browser.searchParams.get("response_type"), "code");
      assert.equal(browser.searchParams.get("code_challenge_method"), "S256");
      assert.equal(browser.searchParams.get("scope"), "read profile");
      const redirect = new URL(browser.searchParams.get("redirect_uri"));
      assert.equal(redirect.hostname, "127.0.0.1"); assert.equal(redirect.protocol, "http:"); assert.equal(redirect.pathname, "/oauth/complete");
      redirect.searchParams.set("state", browser.searchParams.get("state")); redirect.searchParams.set("code", authorizationCode);
      const response = await fetch(redirect); // The only real network I/O is this local callback.
      assert.equal(response.status, 200); await response.text();
    },
    emit(event) {
      events.push(event);
      if (event.kind === "deviceCode") deviceShown.resolve(event);
      if (["done", "error", "cancelled"].includes(event.kind)) { completed.set(event.loginId, event); terminal.get(event.loginId)?.resolve(event); }
    },
  });
  const wait = loginId => {
    if (completed.has(loginId)) return Promise.resolve(completed.get(loginId));
    if (!terminal.has(loginId)) terminal.set(loginId, Promise.withResolvers());
    return terminal.get(loginId).promise;
  };
  t.after(async () => {
    owner.abort();
    for (const event of events) oauth.cancel(event.loginId);
    held?.response.resolve(json({ access_token: "late-private-access", refresh_token: "late-private-refresh", token_type: "Bearer" }));
    await immediate();
    assert.equal(customCalls, 0);
  });
  return { oauth, chooser, rows, secrets, calls, events, tokenBodies, checkedUrls, browsers, deviceShown, wait,
    signalCalls: () => signalCalls,
    holdNextToken() { held = { started: Promise.withResolvers(), response: Promise.withResolvers() }; return held; },
    unload() { loaded = false; owner.abort(new Error("private-unload-reason")); },
  };
}

function noRendererCredentials(f) {
  const output = JSON.stringify(f.events);
  for (const secret of [access, refresh, fresh, authorizationCode, deviceCode, "late-private-access", "late-private-refresh", "private-unload-reason"])
    assert.ok(!output.includes(secret), `renderer must not receive ${secret}`);
  assert.doesNotMatch(output, /"(?:accessToken|refreshToken|credential|code_verifier)"/);
  for (const body of f.tokenBodies) if (body.has("code_verifier")) assert.ok(!output.includes(body.get("code_verifier")));
}

async function verifyRefresh(f, event) {
  assert.equal(event.kind, "done", JSON.stringify(event));
  assert.match(event.providerId, /^native-account-/);
  assert.equal(f.rows.get(event.providerId).enabled, true);
  const ref = secretRefForProviderOauth(event.providerId);
  const stored = JSON.parse(f.secrets.get(ref)); stored.expiresAt = 1; f.secrets.set(ref, JSON.stringify(stored));
  const credential = await f.oauth.resolvePluginInferenceCredential(event.providerId);
  assert.equal(credential.apiKey, fresh); assert.ok(!JSON.stringify(credential).includes(refresh));
  const refreshed = JSON.parse(f.secrets.get(ref));
  assert.equal(refreshed.accessToken, fresh); assert.equal(refreshed.refreshToken, refresh);
  const ownVendor = (await f.oauth.listVendors()).find(vendor => vendor.vendorId === f.chooser);
  assert.deepEqual(ownVendor.accounts.map(account => account.providerId), [event.providerId]);
  assert.equal(f.calls.filter(call => call.method === "providers.completeTemplateOAuth").length, 1);
  const write = f.calls.findIndex(call => call.method === "secrets.set");
  const complete = f.calls.findIndex(call => call.method === "providers.completeTemplateOAuth");
  assert.ok(write >= 0 && complete > write);
  assert.equal(f.signalCalls(), 2, "both login and refresh use the plugin lifetime signal");
  noRendererCredentials(f);
}

test("public template chooser creates a native PKCE account, then expires and refreshes without custom plugin OAuth", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const { loginId } = await f.oauth.start(f.chooser);
  const done = await f.wait(loginId);
  await verifyRefresh(f, done);
  assert.equal(f.browsers.length, 1);
  assert.ok(f.checkedUrls.includes("https://auth.example.test/token"));
  assert.deepEqual(f.events.map(event => event.kind), ["authUrl", "done"]);
  await assert.rejects(fetch(f.browsers[0].searchParams.get("redirect_uri")), "loopback listener must be closed");
});

test("public template chooser executes device-code login and refresh through the actual Host engine", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });
  const f = fixture(t, "device_code");
  const { loginId } = await f.oauth.start(f.chooser);
  const shown = await f.deviceShown.promise;
  assert.equal(shown.userCode, "SHOW-CODE");
  assert.equal(f.rows.size, 1); assert.equal([...f.rows.values()][0].enabled, false); assert.equal(f.secrets.size, 0);
  await immediate(); t.mock.timers.tick(1000); await immediate();
  await verifyRefresh(f, await f.wait(loginId));
  assert.equal(f.browsers.length, 0);
  assert.deepEqual(f.events.map(event => event.kind), ["deviceCode", "done"]);
});

for (const action of ["cancel", "unload"]) {
  test(`${action} during a declarative token exchange deletes only the pending account and rejects late credentials`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    const first = await f.oauth.start(f.chooser), survivor = await f.wait(first.loginId);
    assert.equal(survivor.kind, "done");
    const before = f.secrets.get(secretRefForProviderOauth(survivor.providerId));
    const held = f.holdNextToken();
    const pending = await f.oauth.start(f.chooser);
    const requestSignal = await held.started.promise;
    assert.equal(f.rows.size, 2);
    if (action === "cancel") assert.equal(f.oauth.cancel(pending.loginId), true);
    else f.unload(); // This aborts bridge.providerOAuthSignal, not a mocked engine.
    const result = await f.wait(pending.loginId);
    assert.equal(result.kind, action === "cancel" ? "cancelled" : "error");
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual([...f.rows.keys()], [survivor.providerId]);
    let bodyCancelled = false;
    held.response.resolve(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: "late-private-access", refresh_token: "late-private-refresh", token_type: "Bearer" })));
    }, cancel() { bodyCancelled = true; } }), { headers: { "content-type": "application/json" } }));
    await immediate(); await immediate();
    assert.equal(bodyCancelled, true);
    assert.equal(f.secrets.size, 1); assert.equal(f.secrets.get(secretRefForProviderOauth(survivor.providerId)), before);
    assert.equal(f.calls.filter(call => call.method === "providers.completeTemplateOAuth").length, 1);
    assert.equal(f.calls.filter(call => call.method === "secrets.set").length, 1);
    assert.equal(f.events.filter(event => event.loginId === pending.loginId && event.kind === "done").length, 0);
    await assert.rejects(fetch(f.browsers.at(-1).searchParams.get("redirect_uri")));
    noRendererCredentials(f);
  });
}
