/**
 * Contract test for the GitHub device authorization flow (ADR
 * github-connector).
 *
 * The driver asks GitHub for a device code, shows it, and polls until the
 * user approves in a browser. What matters here is that it polls no faster
 * than GitHub allows, stops for every reason a login can end — approval,
 * refusal, expiry, the user closing the dialog — and never makes another
 * request once it was told to stop.
 *
 * Every request goes to the scripted `fetchImpl`; nothing here reaches GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { runGitHubDeviceFlow } = await import("../electron/main/github/device-flow.ts");

const CLIENT_ID = "Iv1.fixtureclientid";
const TOKEN = "gho_deviceFlowFixtureToken";
const DEVICE_CODE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deviceCodeResponse(overrides = {}) {
  return {
    device_code: DEVICE_CODE,
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

/**
 * A scripted GitHub plus a clock that only moves when the driver sleeps.
 * `steps` answers the requests in order; a step may be a response or a
 * function producing one (or throwing, for a network failure).
 */
function harness(steps, { clientId = CLIENT_ID, scopes = ["repo", "read:org"], signal } = {}) {
  const requests = [];
  const sleeps = [];
  const events = [];
  let clock = Date.parse("2026-11-20T08:00:00.000Z");
  const controller = new AbortController();
  const fetchImpl = async (url, init = {}) => {
    const request = { url: String(url), init, params: new URLSearchParams(String(init.body ?? "")) };
    requests.push(request);
    const step = steps[requests.length - 1];
    if (step === undefined) throw new Error(`unexpected request #${requests.length} to ${url}`);
    return typeof step === "function" ? step(request) : json(step);
  };
  const sleep = async (ms, sleepSignal) => {
    sleeps.push(ms);
    assert.ok(sleepSignal instanceof AbortSignal, "sleep receives the abort signal");
    clock += ms;
  };
  const options = {
    clientId,
    scopes,
    onEvent: (event) => events.push(event),
    signal: signal ?? controller.signal,
    fetchImpl,
    sleep,
    now: () => clock,
  };
  return { options, requests, sleeps, events, controller };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the flow to reject");
}

test("the flow shows one device code, polls at the interval, and resolves the token", async () => {
  const run = harness([
    deviceCodeResponse(),
    { error: "authorization_pending" },
    { access_token: TOKEN, token_type: "bearer", scope: "repo,read:org" },
  ]);
  const result = await runGitHubDeviceFlow(run.options);

  assert.deepEqual(result, { token: TOKEN });
  assert.deepEqual(
    run.events.filter((event) => event.kind === "deviceCode"),
    [
      {
        kind: "deviceCode",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    ],
  );
  assert.deepEqual(run.sleeps, [5000, 5000]);

  assert.equal(run.requests.length, 3);
  assert.equal(run.requests[0].url, DEVICE_URL);
  assert.equal(run.requests[0].params.get("client_id"), CLIENT_ID);
  assert.equal(run.requests[0].params.get("scope"), "repo read:org");
  for (const request of run.requests.slice(1)) {
    assert.equal(request.url, TOKEN_URL);
    assert.equal(request.params.get("client_id"), CLIENT_ID);
    assert.equal(request.params.get("device_code"), DEVICE_CODE);
    assert.equal(
      request.params.get("grant_type"),
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  }
  for (const request of run.requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(request.init.method, "POST");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(headers.get("authorization"), null);
    assert.equal(request.init.redirect, "error");
    assert.ok(request.init.signal instanceof AbortSignal);
  }
});

test("the workflow scope is requested only when the caller passes it", async () => {
  const run = harness([deviceCodeResponse(), { access_token: TOKEN }], {
    scopes: ["repo", "read:org", "workflow"],
  });
  await runGitHubDeviceFlow(run.options);
  assert.equal(run.requests[0].params.get("scope"), "repo read:org workflow");
});

test("slow_down without an interval adds five seconds to every later wait", async () => {
  const run = harness([
    deviceCodeResponse(),
    { error: "slow_down" },
    { error: "authorization_pending" },
    { access_token: TOKEN },
  ]);
  await runGitHubDeviceFlow(run.options);
  assert.deepEqual(run.sleeps, [5000, 10000, 10000]);
});

test("slow_down with an interval uses the interval GitHub returned", async () => {
  const run = harness([
    deviceCodeResponse(),
    { error: "slow_down", interval: 12 },
    { access_token: TOKEN },
  ]);
  await runGitHubDeviceFlow(run.options);
  assert.deepEqual(run.sleeps, [5000, 12000]);
});

test("each way a login can end maps to its own code", async () => {
  const cases = [
    ["expired_token", "GITHUB_LOGIN_EXPIRED"],
    ["access_denied", "GITHUB_LOGIN_DENIED"],
    ["device_flow_disabled", "GITHUB_DEVICE_FLOW_UNAVAILABLE"],
    ["incorrect_device_code", "GITHUB_AUTH_FAILED"],
    ["unsupported_grant_type", "GITHUB_AUTH_FAILED"],
    ["incorrect_client_credentials", "GITHUB_AUTH_FAILED"],
  ];
  for (const [oauthError, errorCode] of cases) {
    const run = harness([deviceCodeResponse(), { error: oauthError, error_description: "why" }]);
    const error = await rejection(runGitHubDeviceFlow(run.options));
    assert.equal(error.errorCode, errorCode, oauthError);
    assert.equal(run.requests.length, 2, `${oauthError} stops the polling`);
  }
});

test("an OAuth App without device flow is reported as unavailable at the first step", async () => {
  const run = harness([() => json({ error: "device_flow_disabled" }, 400)]);
  const error = await rejection(runGitHubDeviceFlow(run.options));

  assert.equal(error.errorCode, "GITHUB_DEVICE_FLOW_UNAVAILABLE");
  assert.equal(run.requests.length, 1);
  assert.deepEqual(run.events, []);
});

test("an unknown client id fails the login at the first step", async () => {
  const run = harness([() => json({ error: "Not Found" }, 404)]);
  const error = await rejection(runGitHubDeviceFlow(run.options));
  assert.equal(error.errorCode, "GITHUB_AUTH_FAILED");
  assert.equal(run.requests.length, 1);
});

test("an empty client id makes no request at all", async () => {
  for (const clientId of ["", "   "]) {
    const run = harness([], { clientId });
    const error = await rejection(runGitHubDeviceFlow(run.options));
    assert.equal(error.errorCode, "GITHUB_DEVICE_FLOW_UNAVAILABLE");
    assert.equal(run.requests.length, 0);
    assert.deepEqual(run.sleeps, []);
  }
});

test("polling stops at the device code's expiry even if GitHub never says so", async () => {
  const pending = { error: "authorization_pending" };
  const run = harness([
    deviceCodeResponse({ expires_in: 12 }),
    pending,
    pending,
    pending,
    pending,
  ]);
  const error = await rejection(runGitHubDeviceFlow(run.options));

  assert.equal(error.errorCode, "GITHUB_LOGIN_EXPIRED");
  // Two polls fit in twelve seconds; the last wait is cut at the expiry.
  assert.deepEqual(run.sleeps, [5000, 5000, 2000]);
  assert.equal(run.requests.length, 3);
});

test("an abort during a wait rejects with an abort error and makes no further request", async () => {
  const run = harness([deviceCodeResponse(), { access_token: TOKEN }]);
  let sleeping;
  const entered = new Promise((resolve) => {
    sleeping = resolve;
  });
  run.options.sleep = (_ms, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      sleeping();
    });
  const flow = runGitHubDeviceFlow(run.options);
  await entered;
  run.controller.abort();
  const error = await rejection(flow);

  assert.equal(error.name, "AbortError");
  assert.equal(run.requests.length, 1);
});

test("an abort that a wait did not notice still stops before the next request", async () => {
  const run = harness([deviceCodeResponse(), { access_token: TOKEN }]);
  // A sleep that resolves normally although the signal fired while it ran.
  run.options.sleep = async () => {
    run.controller.abort();
  };
  const error = await rejection(runGitHubDeviceFlow(run.options));

  assert.equal(error.name, "AbortError");
  assert.equal(run.requests.length, 1);
});

test("an already aborted signal makes no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = harness([deviceCodeResponse()], { signal: controller.signal });
  const error = await rejection(runGitHubDeviceFlow(run.options));

  assert.equal(error.name, "AbortError");
  assert.equal(run.requests.length, 0);
});

test("an abort while a request is in flight discards its answer", async () => {
  const run = harness([
    deviceCodeResponse(),
    () => {
      run.controller.abort();
      return json({ access_token: TOKEN });
    },
  ]);
  const error = await rejection(runGitHubDeviceFlow(run.options));
  assert.equal(error.name, "AbortError");
});

test("the default wait is a real timer that an abort cancels at once", async () => {
  const run = harness([deviceCodeResponse(), { access_token: TOKEN }]);
  delete run.options.sleep;
  delete run.options.now;
  const started = Date.now();
  const flow = runGitHubDeviceFlow(run.options);
  setTimeout(() => run.controller.abort(), 20);
  const error = await rejection(flow);

  assert.equal(error.name, "AbortError");
  assert.ok(Date.now() - started < 2_000, "the five second wait did not run to its end");
  assert.equal(run.requests.length, 1);
});

test("a network failure before the code is shown fails the login as retriable", async () => {
  const run = harness([
    () => {
      throw new TypeError("fetch failed");
    },
  ]);
  const error = await rejection(runGitHubDeviceFlow(run.options));

  assert.equal(error.errorCode, "GITHUB_NETWORK");
  assert.equal(error.retriable, true);
  assert.deepEqual(run.events, []);
});

test("a network blip while polling does not end a login the user is approving", async () => {
  const run = harness([
    deviceCodeResponse(),
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("<html>bad gateway</html>", { status: 502 }),
    { access_token: TOKEN },
  ]);
  const result = await runGitHubDeviceFlow(run.options);

  assert.deepEqual(result, { token: TOKEN });
  assert.deepEqual(run.sleeps, [5000, 5000, 5000]);
});

test("an answer without a usable token or device code fails the login", async () => {
  const noCode = harness([{ user_code: "WDJB-MJHT" }]);
  assert.equal(
    (await rejection(runGitHubDeviceFlow(noCode.options))).errorCode,
    "GITHUB_AUTH_FAILED",
  );

  const badToken = harness([deviceCodeResponse(), { access_token: "gho_a\nb" }]);
  const error = await rejection(runGitHubDeviceFlow(badToken.options));
  assert.equal(error.errorCode, "GITHUB_AUTH_FAILED");
  assert.equal(String(error.message).includes("gho_a"), false);
});

test("the page the user is sent to is always on github.com", async () => {
  for (const verification_uri of ["https://evil.example/login/device", "javascript:alert(1)", 7]) {
    const run = harness([deviceCodeResponse({ verification_uri }), { access_token: TOKEN }]);
    await runGitHubDeviceFlow(run.options);
    const [shown] = run.events.filter((event) => event.kind === "deviceCode");
    assert.equal(shown.verificationUri, "https://github.com/login/device");
  }
});

test("a missing or unusable interval and lifetime fall back to GitHub's defaults", async () => {
  const run = harness([
    deviceCodeResponse({ interval: undefined, expires_in: "soon" }),
    { access_token: TOKEN },
  ]);
  await runGitHubDeviceFlow(run.options);
  const [shown] = run.events.filter((event) => event.kind === "deviceCode");
  assert.equal(shown.intervalSeconds, 5);
  assert.equal(shown.expiresInSeconds, 900);
  assert.deepEqual(run.sleeps, [5000]);
});

test("no event carries the device code or the token", async () => {
  const run = harness([
    deviceCodeResponse(),
    { error: "authorization_pending" },
    { access_token: TOKEN },
  ]);
  await runGitHubDeviceFlow(run.options);
  const serialized = JSON.stringify(run.events);
  assert.equal(serialized.includes(DEVICE_CODE), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.ok(run.events.every((event) => event.kind === "deviceCode" || event.kind === "progress"));
});
