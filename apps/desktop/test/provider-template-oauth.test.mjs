import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { setImmediate as immediate } from "node:timers/promises";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { runProviderTemplateOAuth } = await import("../electron/main/provider-template-oauth.ts");
const auth = { flow: "authorization_code", clientId: "public-client", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", scopes: ["read", "profile"] };
const device = { flow: "device_code", clientId: "public-client", deviceAuthorizationUrl: "https://auth.example.com/device", tokenUrl: auth.tokenUrl };
const login = { operation: "login", providerId: "cloud", accountId: "account-2", loginId: "login" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokens = { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600, id_token: "ignored-jwt", headers: { unsafe: "ignored" } };
function context(fetch, extra = {}) {
  return { signal: new AbortController().signal, notify() {}, openExternal() {},
    network: { assertUrl: async url => assert.match(url, /^https:\/\//), fetch }, ...extra };
}
async function callback(url, mutate = () => {}) {
  const authorize = new URL(url);
  const redirect = new URL(authorize.searchParams.get("redirect_uri"));
  redirect.searchParams.set("state", authorize.searchParams.get("state"));
  redirect.searchParams.set("code", "one-use-code");
  mutate(redirect);
  const response = await fetch(redirect);
  await response.text();
  return { authorize, redirect, response };
}

test("authorization-code login uses a real loopback, PKCE S256 and minimal credentials; refresh omits rotation", async () => {
  let browser, tokenBody;
  const before = Date.now();
  const result = await runProviderTemplateOAuth(auth, login, context(async (url, init) => {
    assert.equal(url, auth.tokenUrl); assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
    tokenBody = new URLSearchParams(init.body);
    assert.equal(tokenBody.get("grant_type"), "authorization_code");
    assert.equal(tokenBody.get("client_id"), auth.clientId);
    assert.equal(tokenBody.get("code"), "one-use-code");
    assert.equal(createHash("sha256").update(tokenBody.get("code_verifier")).digest("base64url"), browser.searchParams.get("code_challenge"));
    return json(tokens);
  }, { async openExternal(url) {
    browser = new URL(url);
    assert.equal(browser.searchParams.get("code_challenge_method"), "S256");
    assert.equal(browser.searchParams.get("scope"), "read profile");
    assert.equal(browser.searchParams.get("response_type"), "code");
    assert.equal(new URL(browser.searchParams.get("redirect_uri")).pathname, "/callback");
    await callback(url);
  } }));
  assert.equal(result.accessToken, "access-secret"); assert.equal(result.refreshToken, "refresh-secret");
  assert.ok(result.expiresAt >= before + 3600000 && result.expiresAt <= Date.now() + 3600000);
  assert.deepEqual(Object.keys(result).sort(), ["accessToken", "expiresAt", "refreshToken"]);
  await assert.rejects(fetch(tokenBody.get("redirect_uri")));
  const refreshed = await runProviderTemplateOAuth(auth, { ...login, operation: "refresh", credential: result }, context(async (_url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), "refresh-secret");
    assert.equal(body.has("client_secret"), false);
    return json({ access_token: "new-access", token_type: "bearer" });
  }));
  assert.deepEqual(refreshed, { accessToken: "new-access" });
});

test("invalid callback state and shape do not consume login before a valid callback", async () => {
  let exchanges = 0, redirect;
  const result = await runProviderTemplateOAuth(auth, login, context(async () => { exchanges++; return json(tokens); }, { async openExternal(url) {
    redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
    for (const mutate of [
      u => u.searchParams.set("state", "wrong-private-state"),
      u => u.searchParams.append("state", "duplicate"),
      u => u.searchParams.delete("state"),
      u => u.searchParams.append("code", "duplicate"),
      u => u.searchParams.set("error", "access_denied"),
      u => u.searchParams.set("code", ""),
      u => u.searchParams.delete("code"),
      u => { u.searchParams.delete("code"); u.searchParams.append("error", "access_denied"); u.searchParams.append("error", "other"); },
    ]) {
      const { response } = await callback(url, mutate);
      assert.equal(response.status, 400);
      assert.equal(exchanges, 0, "unauthenticated/malformed callbacks must never exchange a token");
    }
    assert.equal((await callback(url)).response.status, 200);
  } }));
  assert.equal(result.accessToken, "access-secret");
  assert.equal(exchanges, 1);
  await assert.rejects(fetch(redirect));
});

test("state-bound OAuth denial terminates login without token exchange", async () => {
  let redirect;
  await assert.rejects(runProviderTemplateOAuth(auth, login, context(() => assert.fail("must not exchange"), { async openExternal(url) {
    redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
    const denied = await callback(url, u => { u.searchParams.delete("code"); u.searchParams.set("error", "access_denied"); });
    assert.equal(denied.response.status, 200);
  } })), error => error.code === "OAUTH_DENIED");
  await assert.rejects(fetch(redirect));
});

test("callback results are independently revalidated after the trusted I/O seam", async () => {
  for (const mutate of [u => u.searchParams.set("state", "wrong-private-state"), u => u.searchParams.append("code", "duplicate")]) {
    let closed = false;
    await assert.rejects(runProviderTemplateOAuth(auth, login, context(() => assert.fail("must not exchange"), {
      createCallback(_path, _signal, expectedState) {
        const url = new URL("http://127.0.0.1:1000/callback");
        url.searchParams.set("state", expectedState);
        url.searchParams.set("code", "synthetic-code");
        mutate(url);
        return Promise.resolve({ redirectUri: "http://127.0.0.1:1000/callback", result: Promise.resolve(url), close() { closed = true; } });
      },
    })), error => /OAUTH_(STATE|CALLBACK)/.test(error.code) && !String(error).includes("private-state"));
    assert.equal(closed, true);
  }
});

test("abort after browser open closes the callback and sanitizes the abort reason", async () => {
  const controller = new AbortController(); let redirect;
  await assert.rejects(runProviderTemplateOAuth(auth, login, context(() => assert.fail("no request"), { signal: controller.signal, openExternal(url) {
    redirect = new URL(url).searchParams.get("redirect_uri"); controller.abort(new Error("secret-abort-reason"));
  } })), error => error.code === "OAUTH_CANCELLED" && !String(error).includes("secret"));
  await assert.rejects(fetch(redirect));
});

test("device flow observes interval, pending and persistent slow_down, then returns tokens", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });
  const polls = []; const events = [];
  const running = runProviderTemplateOAuth(device, login, context(async (url, init) => {
    const body = new URLSearchParams(init.body);
    if (url === device.deviceAuthorizationUrl) return json({ device_code: "device-secret", user_code: "ABCD", verification_uri: "https://auth.example.com/activate", interval: 1, expires_in: 120 });
    assert.equal(body.get("device_code"), "device-secret");
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    polls.push(Date.now());
    return polls.length === 1 ? json({ error: "authorization_pending" }, 400) : polls.length === 2 ? json({ error: "slow_down" }, 400) : polls.length === 3 ? json({ error: "authorization_pending" }, 400) : json(tokens);
  }, { notify(event) { events.push(event); } }));
  await immediate(); assert.equal(polls.length, 0);
  for (const interval of [1000, 1000, 6000, 6000]) { t.mock.timers.tick(interval); await immediate(); }
  assert.equal((await running).accessToken, "access-secret");
  assert.deepEqual(polls.map(time => time - 1700000000000), [1000, 2000, 8000, 14000]);
  assert.deepEqual(events, [{ kind: "deviceCode", userCode: "ABCD", verificationUri: "https://auth.example.com/activate", intervalSeconds: 1, expiresInSeconds: 120 }]);
  assert.ok(!JSON.stringify(events).includes("device-secret"));
});

test("timeouts cover an unresponsive transport and browser and clean up", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const running = runProviderTemplateOAuth(auth, { ...login, operation: "refresh", credential: { accessToken: "x", refreshToken: "y" } }, context(() => new Promise(() => {}), { requestTimeoutMs: 20 }));
  const checked = assert.rejects(running, error => error.code === "OAUTH_NETWORK_TIMEOUT");
  await immediate(); t.mock.timers.tick(20); await checked;
  let redirect;
  const browserRun = runProviderTemplateOAuth(auth, login, context(() => assert.fail("no request"), { timeoutMs: 40, openExternal(url) { redirect = new URL(url).searchParams.get("redirect_uri"); return new Promise(() => {}); } }));
  const browserChecked = assert.rejects(browserRun, error => error.code === "OAUTH_TIMEOUT");
  while (!redirect) await immediate();
  t.mock.timers.tick(40); await browserChecked;
  await assert.rejects(fetch(redirect));
});

test("response/status validation and errors never echo response bodies, tokens or transport errors", async () => {
  const request = { ...login, operation: "refresh", credential: { accessToken: "secret-old", refreshToken: "secret-refresh" } };
  for (const response of [json({ error: "invalid_grant", error_description: "secret-description" }, 400), json({ error: "slow_down", access_token: "secret" }, 200), json(tokens, 302), json({ ...tokens, token_type: "MAC" }), json({ ...tokens, expires_in: "3600" }), json({ ...tokens, refresh_token: "" }), json({ access_token: "x".repeat(70000) })]) {
    await assert.rejects(runProviderTemplateOAuth(auth, request, context(async () => response)), error => /^OAUTH_/.test(error.code) && !String(error).includes("secret") && error.cause === undefined);
  }
  await assert.rejects(runProviderTemplateOAuth(auth, request, context(async () => { throw new Error("secret-transport"); })), error => error.code === "OAUTH_NETWORK" && !String(error).includes("secret"));
  for (const body of ["secret-invalid-json", "[]", "null"]) {
    await assert.rejects(runProviderTemplateOAuth(auth, request, context(async () => new Response(body, { headers: { "content-type": "application/json" } }))), error => error.code === "OAUTH_RESPONSE" && !String(error).includes("secret"));
  }
});

test("configuration validation fails closed before network/browser and custom remains plugin-owned", async () => {
  for (const config of [{}, { flow: "custom" }, { ...auth, clientSecret: "secret" }, { ...auth, tokenUrl: "http://127.0.0.1/token" }, { ...auth, redirectPath: "//evil.com" }]) {
    await assert.rejects(runProviderTemplateOAuth(config, login, context(() => assert.fail("no request"), { openExternal() { assert.fail("no browser"); } })), error => error.code === "OAUTH_CONFIG");
  }
});

test("device expiry and abort stop polling before leaking credentials to notifications", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const running = runProviderTemplateOAuth(device, login, context(async url => {
    assert.equal(url, device.deviceAuthorizationUrl);
    return json({ device_code: "hidden", user_code: "SHOW", verification_uri: "https://auth.example.com/activate", expires_in: 1 });
  }));
  const checked = assert.rejects(running, error => error.code === "OAUTH_EXPIRED");
  await immediate(); t.mock.timers.tick(1000); await checked;
  const controller = new AbortController();
  await assert.rejects(runProviderTemplateOAuth(device, login, context(async url => {
    assert.equal(url, device.deviceAuthorizationUrl);
    return json({ device_code: "hidden", user_code: "SHOW", verification_uri: "https://auth.example.com/activate", expires_in: 60 });
  }, { signal: controller.signal, notify() { controller.abort("private-reason"); } })), error => error.code === "OAUTH_CANCELLED");
});

test("device connection timeouts double the polling interval without replaying immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });
  const polls = [];
  const running = runProviderTemplateOAuth(device, login, context(async url => {
    if (url === device.deviceAuthorizationUrl) return json({ device_code: "hidden", user_code: "SHOW", verification_uri: "https://auth.example.com/activate", expires_in: 60, interval: 1 });
    polls.push(Date.now());
    return polls.length === 1 ? new Promise(() => {}) : json(tokens);
  }, { requestTimeoutMs: 20 }));
  await immediate(); t.mock.timers.tick(1000); await immediate();
  t.mock.timers.tick(20); await immediate();
  assert.equal(polls.length, 1);
  t.mock.timers.tick(2000); await immediate();
  assert.equal((await running).accessToken, "access-secret");
  assert.deepEqual(polls, [1700000001000, 1700000003020]);
});

test("response streaming is bounded in time and cancellation releases the reader", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const running = runProviderTemplateOAuth(auth, { ...login, operation: "refresh", credential: { accessToken: "old", refreshToken: "refresh" } }, context(async () => new Response(stream, { headers: { "content-type": "application/json" } }), { requestTimeoutMs: 20 }));
  const checked = assert.rejects(running, error => error.code === "OAUTH_NETWORK_TIMEOUT");
  await immediate(); t.mock.timers.tick(20); await checked; await immediate();
  assert.equal(cancelled, true);
});

test("wrong callback paths and methods are ignored; the declared callback path remains usable", async () => {
  await runProviderTemplateOAuth({ ...auth, redirectPath: "/oauth/complete" }, login, context(async () => json(tokens), { async openExternal(url) {
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
    assert.equal(redirect.pathname, "/oauth/complete");
    const wrong = new URL(redirect); wrong.pathname = "/other";
    const missing = await fetch(wrong); assert.equal(missing.status, 404); await missing.text();
    const post = await fetch(redirect, { method: "POST" }); assert.equal(post.status, 404); await post.text();
    await callback(url);
  } }));
});

test("OAuth error codes are allowlisted and refresh rotation returns only permitted fields", async () => {
  const request = { ...login, operation: "refresh", credential: { accessToken: "old", refreshToken: "refresh" } };
  for (const [error, code] of [["invalid_grant", "OAUTH_INVALID_GRANT"], ["access_denied", "OAUTH_DENIED"], ["expired_token", "OAUTH_EXPIRED"], ["secret-unknown-error", "OAUTH_RESPONSE"]]) {
    await assert.rejects(runProviderTemplateOAuth(device, request, context(async () => json({ error, error_description: "secret-description" }, 400))), failure => failure.code === code && !String(failure).includes("secret"));
  }
  const rotated = await runProviderTemplateOAuth(device, request, context(async () => json({ ...tokens, refresh_token: "rotated" })));
  assert.equal(rotated.refreshToken, "rotated");
  await assert.rejects(runProviderTemplateOAuth(device, { ...request, credential: { accessToken: "old" } }, context(() => assert.fail("no request"))), error => error.code === "OAUTH_INVALID_GRANT");
});

test("outbound policy denial blocks both browser launch and token POST without exposing its diagnostic", async () => {
  const ctx = context(() => assert.fail("must not fetch"), { openExternal() { assert.fail("must not open"); } });
  ctx.network.assertUrl = async () => { throw new Error("secret-policy-diagnostic"); };
  for (const request of [login, { ...login, operation: "refresh", credential: { accessToken: "old", refreshToken: "refresh" } }]) {
    await assert.rejects(runProviderTemplateOAuth(auth, request, ctx), error => error.code === "OAUTH_NETWORK" && !String(error).includes("secret"));
  }
});

test("pre-aborted calls perform no external I/O, and a late callback resource is closed", async () => {
  const controller = new AbortController(); controller.abort("private-reason");
  await assert.rejects(runProviderTemplateOAuth(auth, login, context(() => assert.fail("no network"), { signal: controller.signal, createCallback() { assert.fail("no callback"); } })), error => error.code === "OAUTH_CANCELLED");
  const pending = Promise.withResolvers(); const opened = Promise.withResolvers(); const active = new AbortController(); let closed = false;
  const running = runProviderTemplateOAuth(auth, login, context(() => assert.fail("no network"), { signal: active.signal, createCallback() { opened.resolve(); return pending.promise; } }));
  const checked = assert.rejects(running, error => error.code === "OAUTH_CANCELLED");
  await opened.promise; active.abort(); await checked;
  pending.resolve({ redirectUri: "http://127.0.0.1:1000/callback", result: new Promise(() => {}), close() { closed = true; } });
  await immediate(); assert.equal(closed, true);
});

test("a transport response arriving after cancellation has its body cancelled", async () => {
  const pending = Promise.withResolvers(); const started = Promise.withResolvers(); const controller = new AbortController();
  let cancelled = false;
  const running = runProviderTemplateOAuth(auth, { ...login, operation: "refresh", credential: { accessToken: "old", refreshToken: "refresh" } }, context(() => { started.resolve(); return pending.promise; }, { signal: controller.signal }));
  const checked = assert.rejects(running, error => error.code === "OAUTH_CANCELLED");
  await started.promise; controller.abort(); await checked;
  pending.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await immediate(); assert.equal(cancelled, true);
});
