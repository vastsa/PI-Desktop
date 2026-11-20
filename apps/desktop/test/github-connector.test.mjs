/**
 * Contract test for the main-process GitHub connector (ADR github-connector).
 *
 * The connector owns one credential and everything that can change it: a
 * device login running in the background, a pasted token, and disconnect.
 * These cases pin the orderings that could otherwise store the wrong thing —
 * an old login finishing after a newer one or after disconnect — and the
 * rule that a failed GitHub call is reported as a failure, never cached and
 * never shown as an account with no repositories.
 *
 * Store, REST client, device flow, and event sink are fakes; nothing here
 * reaches GitHub or the host.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createGitHubConnector, getActiveGitHubConnector, setActiveGitHubConnector } =
  await import("../electron/main/github/connector.ts");
const { GitHubApiError } = await import("../electron/main/github/github-api.ts");

const LOGIN_EVENT = "pi-desktop/github/event/login";
const CHANGED_EVENT = "pi-desktop/github/event/changed";
const CLIENT_ID = "Iv1.fixtureclientid";
const TOKEN = "gho_connectorFixtureTokenA";
const OTHER_TOKEN = "gho_connectorFixtureTokenB";
const PAT = "ghp_connectorFixturePat";
const START = Date.parse("2026-11-20T08:00:00.000Z");
const REPO = { owner: "octo-org", name: "hello" };

function storedCredential(overrides = {}) {
  return {
    version: 1,
    token: TOKEN,
    kind: "oauth",
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.example/u/1",
    scopes: ["repo", "read:org"],
    savedAt: "2026-11-19T08:00:00.000Z",
    ...overrides,
  };
}

function repositorySummary(fullName) {
  const [owner, name] = fullName.split("/");
  return { owner, name, fullName, private: true, defaultBranch: "main", archived: false };
}

function apiError(errorCode, details = {}) {
  return new GitHubApiError(errorCode, `fixture ${errorCode}`, details);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let background work the connector started run to its next wait. */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

function harness({ clientId = CLIENT_ID, credential = null, openExternal } = {}) {
  const state = { credential, clock: START };
  const emitted = [];
  const logs = [];
  const opened = [];
  const returned = [];
  const storeCalls = [];
  const apiCalls = [];
  const flows = [];

  const store = {
    read: async () => {
      storeCalls.push("read");
      return state.credential;
    },
    write: async (next) => {
      storeCalls.push("write");
      state.credential = next;
    },
    clear: async () => {
      storeCalls.push("clear");
      state.credential = null;
    },
  };

  const responders = {
    viewer: async () => ({
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.example/u/1",
      scopes: ["repo", "read:org"],
    }),
    listRepositories: async () => ({
      repositories: [repositorySummary("octo-org/Hello"), repositorySummary("octocat/dotfiles")],
      truncated: false,
    }),
    listBranches: async () => ({
      branches: [{ name: "main", protected: true }],
      defaultBranch: "main",
      truncated: false,
    }),
    findPullRequest: async () => null,
    createPullRequest: async (_token, _repository, input) => ({
      number: 4,
      url: "https://github.com/octo-org/hello/pull/4",
      title: input.title,
      draft: input.draft,
      state: "open",
      head: input.head,
      base: input.base,
    }),
  };
  const api = Object.fromEntries(
    Object.keys(responders).map((method) => [
      method,
      async (...args) => {
        apiCalls.push({ method, args });
        return responders[method](...args);
      },
    ]),
  );

  const runDeviceFlow = (options) => {
    const flow = { options, ...deferred() };
    flows.push(flow);
    return flow.promise;
  };

  const connector = createGitHubConnector({
    store,
    api,
    runDeviceFlow,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    clientId,
    openExternal:
      openExternal ??
      (async (url) => {
        opened.push(url);
      }),
    now: () => new Date(state.clock),
    log: (...args) => logs.push(args),
  });

  /** Call a connector method and keep what it returned for the leak check. */
  const call = async (method, ...args) => {
    const value = await connector[method](...args);
    returned.push(value);
    return value;
  };

  const events = (channel) =>
    emitted.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  const loginEvents = () => events(LOGIN_EVENT);
  const changes = () => events(CHANGED_EVENT);
  const deviceCode = (flow) =>
    flow.options.onEvent({
      kind: "deviceCode",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });

  return {
    connector, call, state, emitted, logs, opened, returned, storeCalls, apiCalls, flows,
    responders, loginEvents, changes, deviceCode,
  };
}

test("status reports a signed-out connector that can start a device login", async () => {
  const h = harness();
  assert.deepEqual(await h.connector.status(), { connected: false, deviceLoginAvailable: true });
  assert.equal(await h.connector.token(), null);
});

test("status describes the stored account without the token", async () => {
  const h = harness({ credential: storedCredential() });
  const status = await h.connector.status();

  assert.deepEqual(status, {
    connected: true,
    deviceLoginAvailable: true,
    account: {
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.example/u/1",
    },
    scopes: ["repo", "read:org"],
    tokenKind: "oauth",
  });
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal(await h.connector.token(), TOKEN);
});

test("device login stores the credential and reports deviceCode, done, then one change", async () => {
  const h = harness();
  const { loginId } = await h.call("startDeviceLogin", { allowWorkflowScope: false });

  // The call returned while the flow is still waiting for the user.
  assert.equal(typeof loginId, "string");
  assert.ok(loginId.length > 0);
  assert.equal(h.flows.length, 1);
  assert.equal(h.flows[0].options.clientId, CLIENT_ID);
  assert.deepEqual(h.flows[0].options.scopes, ["repo", "read:org"]);
  assert.equal(h.flows[0].options.signal.aborted, false);
  assert.equal(h.state.credential, null);

  h.deviceCode(h.flows[0]);
  h.flows[0].options.onEvent({ kind: "progress", message: "Waiting for approval on GitHub…" });
  await settle();
  assert.deepEqual(h.opened, ["https://github.com/login/device"]);

  h.flows[0].resolve({ token: TOKEN });
  await settle();

  assert.deepEqual(h.state.credential, {
    version: 1,
    token: TOKEN,
    kind: "oauth",
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.example/u/1",
    scopes: ["repo", "read:org"],
    savedAt: "2026-11-20T08:00:00.000Z",
  });
  assert.deepEqual(h.apiCalls, [{ method: "viewer", args: [TOKEN] }]);
  assert.deepEqual(h.loginEvents(), [
    {
      loginId,
      vendorId: "github-connector",
      kind: "deviceCode",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    },
    { loginId, vendorId: "github-connector", kind: "progress", message: "Waiting for approval on GitHub…" },
    {
      loginId,
      vendorId: "github-connector",
      kind: "done",
      providerId: "github-connector",
      accountLabel: "octocat",
    },
  ]);
  assert.equal(h.changes().length, 1);
  assert.equal(h.changes()[0].connected, true);
  assert.equal(h.changes()[0].account.login, "octocat");
  assert.equal(h.changes()[0].tokenKind, "oauth");
  // `done` reaches the dialog before the status change reaches the page.
  assert.deepEqual(
    h.emitted.slice(-2).map((entry) => entry.channel),
    [LOGIN_EVENT, CHANGED_EVENT],
  );
  // The finished login is no longer cancellable.
  assert.equal(await h.connector.cancelLogin(loginId), false);
});

test("the workflow scope is requested only on opt-in", async () => {
  const h = harness();
  await h.connector.startDeviceLogin({ allowWorkflowScope: true });
  assert.deepEqual(h.flows[0].options.scopes, ["repo", "read:org", "workflow"]);
});

test("a second login aborts the first, and the first can no longer store its token", async () => {
  const h = harness();
  const first = await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  const second = await h.connector.startDeviceLogin({ allowWorkflowScope: false });

  assert.notEqual(first.loginId, second.loginId);
  assert.equal(h.flows[0].options.signal.aborted, true);
  assert.equal(h.flows[1].options.signal.aborted, false);
  assert.deepEqual(h.loginEvents(), [
    { loginId: first.loginId, vendorId: "github-connector", kind: "cancelled" },
  ]);

  // The first flow ignores its abort and hands over a token anyway.
  h.deviceCode(h.flows[0]);
  h.flows[0].resolve({ token: OTHER_TOKEN });
  await settle();

  assert.equal(h.state.credential, null);
  assert.deepEqual(h.apiCalls, []);
  assert.deepEqual(h.opened, []);
  assert.equal(h.loginEvents().length, 1);
  assert.deepEqual(h.changes(), []);

  h.flows[1].resolve({ token: TOKEN });
  await settle();
  assert.equal(h.state.credential.token, TOKEN);
  assert.equal(h.loginEvents().at(-1).kind, "done");
  assert.equal(h.loginEvents().at(-1).loginId, second.loginId);
});

test("a superseded login that is already validating its token stores nothing", async () => {
  const h = harness();
  const viewer = deferred();
  h.responders.viewer = () => viewer.promise;
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.flows[0].resolve({ token: OTHER_TOKEN });
  await settle();
  assert.equal(h.apiCalls.length, 1);

  h.responders.viewer = async () => ({ login: "second", scopes: ["repo"] });
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  viewer.resolve({ login: "first", scopes: ["repo"] });
  await settle();
  assert.equal(h.state.credential, null);

  h.flows[1].resolve({ token: TOKEN });
  await settle();
  assert.equal(h.state.credential.login, "second");
  assert.equal(h.state.credential.token, TOKEN);
});

test("disconnect during a pending login leaves the store empty after the login resolves", async () => {
  const h = harness({ credential: storedCredential() });
  const { loginId } = await h.connector.startDeviceLogin({ allowWorkflowScope: false });

  const status = await h.call("disconnect");
  assert.deepEqual(status, { connected: false, deviceLoginAvailable: true });
  assert.equal(h.flows[0].options.signal.aborted, true);
  assert.deepEqual(h.loginEvents(), [{ loginId, vendorId: "github-connector", kind: "cancelled" }]);

  h.flows[0].resolve({ token: OTHER_TOKEN });
  await settle();

  assert.equal(h.state.credential, null);
  assert.deepEqual(h.apiCalls, []);
  assert.equal(h.loginEvents().length, 1);
  assert.equal(await h.connector.token(), null);
});

test("disconnect while a login validates its token leaves the store empty", async () => {
  const h = harness();
  const viewer = deferred();
  h.responders.viewer = () => viewer.promise;
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.flows[0].resolve({ token: TOKEN });
  await settle();

  await h.connector.disconnect();
  viewer.resolve({ login: "octocat", scopes: ["repo"] });
  await settle();

  assert.equal(h.state.credential, null);
  assert.equal(h.storeCalls.includes("write"), false);
});

test("cancelLogin ends the current login and ignores a stale id", async () => {
  const h = harness();
  const first = await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  const second = await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  const before = h.loginEvents().length;

  assert.equal(await h.call("cancelLogin", first.loginId), false);
  assert.equal(await h.call("cancelLogin", "no-such-login"), false);
  assert.equal(h.flows[1].options.signal.aborted, false);
  assert.equal(h.loginEvents().length, before);

  assert.equal(await h.call("cancelLogin", second.loginId), true);
  assert.equal(h.flows[1].options.signal.aborted, true);
  assert.deepEqual(h.loginEvents().at(-1), {
    loginId: second.loginId,
    vendorId: "github-connector",
    kind: "cancelled",
  });
  assert.equal(await h.connector.cancelLogin(second.loginId), false);

  // The flow rejects with its abort error; that is not reported a second time.
  h.flows[1].reject(new DOMException("aborted", "AbortError"));
  await settle();
  assert.equal(h.loginEvents().at(-1).kind, "cancelled");
  assert.equal(h.loginEvents().filter((event) => event.kind === "error").length, 0);
  assert.equal(h.state.credential, null);
});

test("a login that fails reports its error and stores nothing", async () => {
  const h = harness();
  const { loginId } = await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.flows[0].reject(apiError("GITHUB_LOGIN_DENIED"));
  await settle();

  // The code travels with the message so the renderer can show its own
  // translation instead of main's English sentence.
  assert.deepEqual(h.loginEvents(), [
    {
      loginId,
      vendorId: "github-connector",
      kind: "error",
      message: "fixture GITHUB_LOGIN_DENIED",
      code: "GITHUB_LOGIN_DENIED",
    },
  ]);
  assert.equal(h.state.credential, null);
  assert.deepEqual(h.changes(), []);
  assert.equal(await h.connector.cancelLogin(loginId), false);
});

test("a login whose token GitHub then rejects reports an error and stores nothing", async () => {
  const h = harness();
  h.responders.viewer = async () => {
    throw apiError("GITHUB_NETWORK", { retriable: true });
  };
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.flows[0].resolve({ token: TOKEN });
  await settle();

  assert.equal(h.loginEvents().at(-1).kind, "error");
  assert.equal(h.loginEvents().at(-1).code, "GITHUB_NETWORK");
  assert.equal(h.state.credential, null);
  assert.equal(JSON.stringify(h.emitted).includes(TOKEN), false);
});

test("a login that fails without a code reports only its message", async () => {
  const h = harness();
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.flows[0].reject(new Error("something unexpected"));
  await settle();

  const event = h.loginEvents().at(-1);
  assert.equal(event.kind, "error");
  assert.equal(event.message, "something unexpected");
  assert.equal("code" in event, false);
});

test("a browser that cannot be opened does not end the login", async () => {
  const h = harness({
    openExternal: async () => {
      throw new Error("DISALLOWED_EXTERNAL_URL");
    },
  });
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.deviceCode(h.flows[0]);
  await settle();
  h.flows[0].resolve({ token: TOKEN });
  await settle();

  assert.equal(h.state.credential.token, TOKEN);
  assert.equal(h.loginEvents().at(-1).kind, "done");
});

test("without a client id device login is unavailable and no flow starts", async () => {
  const h = harness({ clientId: "" });

  assert.deepEqual(await h.connector.status(), { connected: false, deviceLoginAvailable: false });
  const error = await rejection(h.connector.startDeviceLogin({ allowWorkflowScope: false }));
  assert.equal(error.errorCode, "GITHUB_DEVICE_FLOW_UNAVAILABLE");
  assert.equal(h.flows.length, 0);
  assert.deepEqual(h.emitted, []);
});

test("setToken trims a pasted token, validates it, and stores it as a personal token", async () => {
  const h = harness();
  h.responders.viewer = async () => ({ login: "octocat", scopes: ["repo", "read:org"] });
  const status = await h.call("setToken", `  ${PAT}\n`);

  assert.deepEqual(h.apiCalls, [{ method: "viewer", args: [PAT] }]);
  assert.deepEqual(h.state.credential, {
    version: 1,
    token: PAT,
    kind: "pat",
    login: "octocat",
    scopes: ["repo", "read:org"],
    savedAt: "2026-11-20T08:00:00.000Z",
  });
  assert.deepEqual(status, {
    connected: true,
    deviceLoginAvailable: true,
    account: { login: "octocat" },
    scopes: ["repo", "read:org"],
    tokenKind: "pat",
  });
  assert.deepEqual(h.changes(), [status]);
});

test("a token that cannot be a header value is refused before any request", async () => {
  const h = harness({ credential: storedCredential() });
  for (const token of ["ghp_a\nb", "ghp_a b", "", "   ", "\n", "ghp_\u0000x", "a".repeat(4097), 42, null, undefined]) {
    const error = await rejection(h.connector.setToken(token));
    assert.equal(error.errorCode, "GITHUB_INVALID_TOKEN", JSON.stringify(token)?.slice(0, 20));
    assert.equal(String(error.message).includes("ghp_"), false);
  }
  assert.deepEqual(h.apiCalls, []);
  assert.equal(h.state.credential.token, TOKEN);
  assert.deepEqual(h.changes(), []);
});

test("a pasted token with a non-ASCII character is invalid, not a network failure", async () => {
  const h = harness();
  for (const token of ["ghp_abc\u00e9def", "\u201cghp_abcdef\u201d", "ghp_\u4ee4\u724c"]) {
    const error = await rejection(h.connector.setToken(token));
    assert.equal(error.errorCode, "GITHUB_INVALID_TOKEN");
    assert.equal(error.retriable, false);
  }
  assert.deepEqual(h.apiCalls, []);
  assert.equal(h.state.credential, null);
});

test("a classic token without the repo scope is stored with its real scopes", async () => {
  const h = harness();
  h.responders.viewer = async () => ({ login: "octocat", scopes: ["read:user", "gist"] });
  const status = await h.connector.setToken(PAT);

  assert.deepEqual(h.state.credential.scopes, ["read:user", "gist"]);
  assert.deepEqual(status.scopes, ["read:user", "gist"]);
  assert.equal(status.connected, true);
  assert.equal(status.tokenKind, "pat");
});

test("a pasted token GitHub rejects is invalid, and the stored credential is kept", async () => {
  const h = harness({ credential: storedCredential() });
  h.responders.viewer = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };
  const error = await rejection(h.connector.setToken(PAT));

  assert.equal(error.errorCode, "GITHUB_INVALID_TOKEN");
  assert.equal(error.retriable, false);
  assert.equal(String(error.message).includes(PAT), false);
  assert.equal(h.state.credential.token, TOKEN);
  assert.deepEqual(h.changes(), []);
  // The stored account was not the one that failed.
  assert.equal((await h.connector.status()).needsReauthentication, undefined);
});

test("a pasted token that could not be checked is not stored", async () => {
  const h = harness();
  h.responders.viewer = async () => {
    throw apiError("GITHUB_NETWORK", { retriable: true });
  };
  const error = await rejection(h.connector.setToken(PAT));

  assert.equal(error.errorCode, "GITHUB_NETWORK");
  assert.equal(error.retriable, true);
  assert.equal(h.state.credential, null);
  assert.equal(h.storeCalls.includes("write"), false);
});

test("disconnect while a pasted token is being checked wins: the token is not stored", async () => {
  const h = harness({ credential: storedCredential() });
  const viewer = deferred();
  h.responders.viewer = () => viewer.promise;
  const saving = h.connector.setToken(PAT);
  await settle();

  await h.connector.disconnect();
  viewer.resolve({ login: "octocat", scopes: ["repo"] });
  const error = await rejection(saving);

  assert.equal(error.errorCode, "CONFLICT");
  assert.equal(String(error.message).includes(PAT), false);
  assert.equal(h.state.credential, null);
  assert.equal(h.storeCalls.includes("write"), false);
  assert.equal(h.changes().at(-1).connected, false);
});

test("a pasted token replaces a login still waiting for approval", async () => {
  const h = harness();
  const { loginId } = await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  await h.connector.setToken(PAT);

  assert.equal(h.flows[0].options.signal.aborted, true);
  assert.deepEqual(h.loginEvents(), [{ loginId, vendorId: "github-connector", kind: "cancelled" }]);
  h.flows[0].resolve({ token: OTHER_TOKEN });
  await settle();
  assert.equal(h.state.credential.token, PAT);
});

test("every GitHub call without a credential is refused as not connected", async () => {
  const h = harness();
  const pull = { head: "feature", base: "main", title: "t", body: "", draft: false };
  for (const call of [
    () => h.connector.listRepositories({}),
    () => h.connector.listBranches(REPO),
    () => h.connector.findPullRequest(REPO, "feature"),
    () => h.connector.createPullRequest(REPO, pull),
  ]) {
    const error = await rejection(call());
    assert.equal(error.errorCode, "GITHUB_NOT_CONNECTED");
    assert.equal(error.retriable, false);
  }
  assert.deepEqual(h.apiCalls, []);
});

test("branch and pull request calls spend the stored token on the given repository", async () => {
  const h = harness({ credential: storedCredential() });
  const pull = { head: "feature", base: "main", title: "Add it", body: "Why.", draft: true };

  assert.deepEqual(await h.call("listBranches", REPO), {
    branches: [{ name: "main", protected: true }],
    defaultBranch: "main",
    truncated: false,
  });
  assert.equal(await h.call("findPullRequest", REPO, "feature"), null);
  const created = await h.call("createPullRequest", REPO, pull);
  assert.equal(created.number, 4);

  assert.deepEqual(h.apiCalls, [
    { method: "listBranches", args: [TOKEN, REPO] },
    { method: "findPullRequest", args: [TOKEN, REPO, "feature"] },
    { method: "createPullRequest", args: [TOKEN, REPO, pull] },
  ]);
});

test("a rejected stored token flags re-authentication instead of looking like an empty account", async () => {
  const h = harness({ credential: storedCredential() });
  h.responders.listRepositories = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };
  const error = await rejection(h.connector.listRepositories({}));

  assert.equal(error.errorCode, "GITHUB_AUTH_FAILED");
  assert.equal(h.changes().length, 1);
  assert.equal(h.changes()[0].connected, true);
  assert.equal(h.changes()[0].needsReauthentication, true);
  assert.equal(h.changes()[0].account.login, "octocat");

  const status = await h.connector.status();
  assert.equal(status.needsReauthentication, true);
  assert.equal(status.connected, true);
  // The credential is kept so the user sees which account needs attention.
  assert.equal(h.state.credential.token, TOKEN);

  // Still failing: the flag is reported once, not on every call.
  await rejection(h.connector.listRepositories({}));
  assert.equal(h.changes().length, 1);
});

test("a rejected token drops the repository cache, so the list fails rather than going stale", async () => {
  const h = harness({ credential: storedCredential() });
  await h.connector.listRepositories({});
  h.responders.listBranches = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };
  await rejection(h.connector.listBranches(REPO));
  h.responders.listRepositories = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };

  const error = await rejection(h.connector.listRepositories({}));
  assert.equal(error.errorCode, "GITHUB_AUTH_FAILED");
});

test("a new credential or a call that works again clears the re-authentication flag", async () => {
  const h = harness({ credential: storedCredential() });
  const failing = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };
  const working = h.responders.listBranches;

  h.responders.listBranches = failing;
  await rejection(h.connector.listBranches(REPO));
  assert.equal((await h.connector.status()).needsReauthentication, true);

  // GitHub accepts the same token again, e.g. after SSO was authorized.
  h.responders.listBranches = working;
  await h.connector.listBranches(REPO);
  assert.equal((await h.connector.status()).needsReauthentication, undefined);
  assert.equal(h.changes().at(-1).needsReauthentication, undefined);

  h.responders.listBranches = failing;
  await rejection(h.connector.listBranches(REPO));
  assert.equal((await h.connector.status()).needsReauthentication, true);
  const status = await h.connector.setToken(PAT);
  assert.equal(status.needsReauthentication, undefined);
  assert.equal((await h.connector.status()).needsReauthentication, undefined);
});

test("other failures pass through typed and do not flag re-authentication", async () => {
  const h = harness({ credential: storedCredential() });
  for (const [errorCode, details] of [
    ["GITHUB_RATE_LIMITED", { retriable: true, status: 403, resetAt: "2026-11-20T09:00:00.000Z" }],
    ["GITHUB_NETWORK", { retriable: true }],
    ["GITHUB_FORBIDDEN", { status: 403 }],
  ]) {
    h.responders.listRepositories = async () => {
      throw apiError(errorCode, details);
    };
    const error = await rejection(h.connector.listRepositories({}));
    assert.equal(error.errorCode, errorCode);
    assert.equal(error.retriable, details.retriable === true);
  }
  assert.deepEqual(h.changes(), []);
  assert.equal((await h.connector.status()).needsReauthentication, undefined);
});

test("repositories are cached for five minutes", async () => {
  const h = harness({ credential: storedCredential() });
  const listCalls = () => h.apiCalls.filter((entry) => entry.method === "listRepositories").length;

  const first = await h.call("listRepositories", {});
  assert.equal(first.repositories.length, 2);
  assert.equal(first.truncated, false);
  assert.equal(listCalls(), 1);

  h.state.clock = START + 5 * 60_000 - 1;
  assert.deepEqual(await h.connector.listRepositories({}), first);
  assert.equal(listCalls(), 1);

  h.state.clock = START + 5 * 60_000;
  await h.connector.listRepositories({});
  assert.equal(listCalls(), 2);
});

test("refresh, a new token, and disconnect each drop the cache", async () => {
  const h = harness({ credential: storedCredential() });
  const listCalls = () => h.apiCalls.filter((entry) => entry.method === "listRepositories");

  await h.connector.listRepositories({});
  await h.connector.listRepositories({ refresh: true });
  assert.equal(listCalls().length, 2);
  // The refreshed result is what later calls are served from.
  await h.connector.listRepositories({});
  assert.equal(listCalls().length, 2);

  await h.connector.setToken(PAT);
  await h.connector.listRepositories({});
  assert.equal(listCalls().length, 3);
  assert.equal(listCalls()[2].args[0], PAT);

  await h.connector.disconnect();
  h.state.credential = storedCredential();
  await h.connector.listRepositories({});
  assert.equal(listCalls().length, 4);
});

test("a failed listing is not cached: the next call asks again and returns the data", async () => {
  const h = harness({ credential: storedCredential() });
  const working = h.responders.listRepositories;
  h.responders.listRepositories = async () => {
    throw apiError("GITHUB_RATE_LIMITED", { retriable: true, status: 403 });
  };
  const error = await rejection(h.connector.listRepositories({}));
  assert.equal(error.errorCode, "GITHUB_RATE_LIMITED");

  h.responders.listRepositories = working;
  const result = await h.connector.listRepositories({});
  assert.equal(result.repositories.length, 2);
  assert.equal(h.apiCalls.filter((entry) => entry.method === "listRepositories").length, 2);
});

test("a truncated listing stays marked truncated when served from the cache", async () => {
  const h = harness({ credential: storedCredential() });
  h.responders.listRepositories = async () => ({
    repositories: [repositorySummary("octo-org/Hello")],
    truncated: true,
  });
  assert.equal((await h.connector.listRepositories({})).truncated, true);
  assert.equal((await h.connector.listRepositories({ query: "hello" })).truncated, true);
});

test("a listing trimmed for organization SSO stays marked through the cache and the filter", async () => {
  const h = harness({ credential: storedCredential() });
  h.responders.listRepositories = async () => ({
    repositories: [repositorySummary("octo-org/Hello"), repositorySummary("octocat/dotfiles")],
    truncated: false,
    ssoPartial: true,
  });
  h.responders.listBranches = async () => ({
    branches: [{ name: "main", protected: true }],
    defaultBranch: "main",
    truncated: false,
    ssoPartial: true,
  });

  assert.equal((await h.connector.listRepositories({})).ssoPartial, true);
  // Served from the cache, and narrowed by a query: still incomplete.
  assert.equal((await h.connector.listRepositories({})).ssoPartial, true);
  assert.equal((await h.connector.listRepositories({ query: "hello" })).ssoPartial, true);
  assert.equal(h.apiCalls.filter((entry) => entry.method === "listRepositories").length, 1);
  assert.equal((await h.connector.listBranches(REPO)).ssoPartial, true);

  // After the organization is authorized, a refresh reads a complete list.
  h.responders.listRepositories = async () => ({
    repositories: [repositorySummary("octo-org/Hello")],
    truncated: false,
  });
  const refreshed = await h.connector.listRepositories({ refresh: true });
  assert.equal("ssoPartial" in refreshed, false);
  assert.equal("ssoPartial" in (await h.connector.listRepositories({})), false);
});

test("query filters by a case-insensitive part of the full name, in main", async () => {
  const h = harness({ credential: storedCredential() });

  const byOwner = await h.connector.listRepositories({ query: "OCTO-ORG/" });
  assert.deepEqual(byOwner.repositories.map((entry) => entry.fullName), ["octo-org/Hello"]);
  const byName = await h.connector.listRepositories({ query: "  dotFILES " });
  assert.deepEqual(byName.repositories.map((entry) => entry.fullName), ["octocat/dotfiles"]);
  const none = await h.connector.listRepositories({ query: "nothing-matches" });
  assert.deepEqual(none.repositories, []);
  const all = await h.connector.listRepositories({ query: "" });
  assert.equal(all.repositories.length, 2);

  assert.equal(h.apiCalls.filter((entry) => entry.method === "listRepositories").length, 1);
  // A caller that edits its result cannot change what the next caller gets.
  all.repositories.length = 0;
  assert.equal((await h.connector.listRepositories({})).repositories.length, 2);
});

test("callers that ask while a listing is loading share that one request", async () => {
  const h = harness({ credential: storedCredential() });
  const pending = deferred();
  h.responders.listRepositories = () => pending.promise;

  const first = h.connector.listRepositories({});
  const second = h.connector.listRepositories({ query: "hello" });
  await settle();
  assert.equal(h.apiCalls.filter((entry) => entry.method === "listRepositories").length, 1);

  pending.resolve({
    repositories: [repositorySummary("octo-org/Hello"), repositorySummary("octocat/dotfiles")],
    truncated: false,
  });
  assert.equal((await first).repositories.length, 2);
  assert.equal((await second).repositories.length, 1);
});

test("a listing that finishes after disconnect is not kept for the next account", async () => {
  const h = harness({ credential: storedCredential() });
  const pending = deferred();
  h.responders.listRepositories = () => pending.promise;
  const stale = h.connector.listRepositories({});
  await settle();

  await h.connector.disconnect();
  pending.resolve({ repositories: [repositorySummary("octo-org/Hello")], truncated: false });
  await stale;

  h.state.credential = storedCredential();
  h.responders.listRepositories = async () => ({ repositories: [], truncated: false });
  assert.deepEqual((await h.connector.listRepositories({})).repositories, []);
});

test("disconnect clears the store and reports the change", async () => {
  const h = harness({ credential: storedCredential() });
  const status = await h.connector.disconnect();

  assert.deepEqual(status, { connected: false, deviceLoginAvailable: true });
  assert.equal(h.state.credential, null);
  assert.deepEqual(h.changes(), [status]);
  // GitHub is not asked to revoke: that needs the OAuth App's secret.
  assert.deepEqual(h.apiCalls, []);
});

test("onChange listeners hear every status change until they unsubscribe", async () => {
  const h = harness();
  const heard = [];
  const stop = h.connector.onChange((status) => heard.push(status));
  h.connector.onChange(() => {
    throw new Error("a listener that throws must not break the connector");
  });

  await h.connector.setToken(PAT);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].connected, true);

  stop();
  await h.connector.disconnect();
  assert.equal(heard.length, 1);
  assert.equal(h.changes().length, 2);
});

test("dispose aborts a pending login and silences it", async () => {
  const h = harness();
  await h.connector.startDeviceLogin({ allowWorkflowScope: false });
  h.connector.dispose();

  assert.equal(h.flows[0].options.signal.aborted, true);
  const before = h.emitted.length;
  h.flows[0].resolve({ token: TOKEN });
  await settle();

  assert.equal(h.state.credential, null);
  assert.equal(h.emitted.length, before);
  assert.deepEqual(h.apiCalls, []);
});

test("the token never appears in an event, a returned value, or a log line", async () => {
  const h = harness();
  h.responders.viewer = async (token) => ({
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.example/u/1",
    scopes: ["repo", "read:org"],
    // A hostile or buggy client echoing the secret must not get it forwarded.
    token,
  });

  const { loginId } = await h.call("startDeviceLogin", { allowWorkflowScope: true });
  h.deviceCode(h.flows[0]);
  h.flows[0].resolve({ token: TOKEN });
  await settle();
  await h.call("status");
  await h.call("listRepositories", {});
  await h.call("listRepositories", { query: "hello", refresh: true });
  await h.call("listBranches", REPO);
  await h.call("findPullRequest", REPO, "feature");
  await h.call("createPullRequest", REPO, { head: "f", base: "main", title: "t", body: "", draft: false });
  await h.call("cancelLogin", loginId);

  h.responders.listRepositories = async () => {
    throw apiError("GITHUB_AUTH_FAILED", { status: 401 });
  };
  const authError = await rejection(h.connector.listRepositories({ refresh: true }));
  h.returned.push({ message: authError.message, fields: { ...authError } });

  await h.call("setToken", ` ${PAT} `);
  h.responders.viewer = async () => {
    throw new Error(`the host said no to ${OTHER_TOKEN}`);
  };
  const setError = await rejection(h.connector.setToken(OTHER_TOKEN));
  h.returned.push({ message: setError.message, fields: { ...setError } });
  await h.call("startDeviceLogin", { allowWorkflowScope: false });
  h.flows[1].resolve({ token: OTHER_TOKEN });
  await settle();
  await h.call("disconnect");

  assert.ok(h.emitted.length >= 6, "the scenario emitted events");
  assert.ok(h.logs.length >= 1, "the scenario logged");
  const surfaces = {
    emitted: JSON.stringify(h.emitted),
    returned: JSON.stringify(h.returned),
    logs: JSON.stringify(h.logs),
  };
  for (const [surface, serialized] of Object.entries(surfaces)) {
    for (const secret of [TOKEN, PAT, OTHER_TOKEN]) {
      assert.equal(serialized.includes(secret), false, `${surface} leaked a token`);
    }
  }
  // The only way out of the connector for the token is the main-only accessor.
  assert.equal(h.state.credential, null);
});

test("the active connector is a process-wide handle that can be cleared", () => {
  const h = harness();
  assert.equal(getActiveGitHubConnector(), null);
  setActiveGitHubConnector(h.connector);
  assert.equal(getActiveGitHubConnector(), h.connector);
  setActiveGitHubConnector(null);
  assert.equal(getActiveGitHubConnector(), null);
});
