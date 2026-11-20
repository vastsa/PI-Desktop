/**
 * Contract test for the adapter that lets the vendor-account login dialog
 * report a GitHub device login (ADR github-connector).
 *
 * `OAuthLoginDialog` watches an `OAuthLoginSession`; the session is built
 * from an `OAuthLoginApi`. The adapter maps that API onto the connector's own
 * channels, so the dialog shows the device code and cancels the right login
 * without knowing GitHub is not a model vendor.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { GITHUB_LOGIN_VENDOR, beginGitHubLogin, githubLoginApi } = await import(
  "../src/features/settings/connectors/github-login-session.ts"
);

function connectorApi({ start } = {}) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
    api: {
      onGithubLogin: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      startGithubLogin: async (input) => {
        calls.push({ method: "startGithubLogin", input });
        if (start) return start(input);
        return { loginId: "login-1" };
      },
      cancelGithubLogin: async (loginId) => {
        calls.push({ method: "cancelGithubLogin", input: loginId });
        return { ok: true };
      },
    },
  };
}

const event = (loginId, body) => ({ loginId, vendorId: "github-connector", ...body });

test("the synthetic vendor names GitHub and owns no provider account", () => {
  assert.deepEqual(GITHUB_LOGIN_VENDOR, {
    vendorId: "github-connector",
    name: "GitHub",
    isSubscription: false,
    accounts: [],
  });
});

test("starting carries the workflow choice, and the vendor id never reaches main", async () => {
  for (const allowWorkflowScope of [false, true]) {
    const fake = connectorApi();
    const adapter = githubLoginApi(fake.api, { allowWorkflowScope });
    assert.deepEqual(await adapter.startOauthLogin("github-connector"), { loginId: "login-1" });
    assert.deepEqual(fake.calls, [{ method: "startGithubLogin", input: { allowWorkflowScope } }]);
  }
});

test("cancel names the login, and a device login has no prompt to answer", async () => {
  const fake = connectorApi();
  const adapter = githubLoginApi(fake.api, { allowWorkflowScope: false });

  assert.deepEqual(await adapter.cancelOauthLogin("login-1"), { ok: true });
  assert.deepEqual(
    await adapter.respondOauthLogin({ loginId: "login-1", promptId: "p", value: "v" }),
    { ok: false },
  );
  assert.deepEqual(fake.calls, [{ method: "cancelGithubLogin", input: "login-1" }]);
});

test("a session delivers this login's events and drops another login's", async () => {
  const fake = connectorApi();
  const session = beginGitHubLogin(fake.api, { allowWorkflowScope: true });
  const seen = [];
  session.subscribe((entry) => seen.push(entry.kind));

  // An event that beats the start result is held until the id is known.
  fake.emit(event("login-1", { kind: "progress", message: "early" }));
  fake.emit(event("login-0", { kind: "error", message: "an older login" }));
  await new Promise((resolve) => setImmediate(resolve));
  fake.emit(
    event("login-1", {
      kind: "deviceCode",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
    }),
  );
  fake.emit(event("login-1", { kind: "done", providerId: "github-connector", accountLabel: "octocat" }));

  assert.deepEqual(seen, ["progress", "deviceCode", "done"]);
  assert.deepEqual(fake.calls, [
    { method: "startGithubLogin", input: { allowWorkflowScope: true } },
  ]);

  assert.equal(await session.cancel(), true);
  assert.deepEqual(fake.calls.at(-1), { method: "cancelGithubLogin", input: "login-1" });
  session.dispose();
  assert.equal(fake.listenerCount(), 0);
});

test("a login that could not start is reported to the dialog as an error", async () => {
  const fake = connectorApi({
    start: async () => {
      throw new Error("Sign-in with a code is not configured in this build.");
    },
  });
  const session = beginGitHubLogin(fake.api, { allowWorkflowScope: false });
  const seen = [];
  session.subscribe((entry) => seen.push(entry));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "error");
  assert.match(seen[0].message, /not configured/);
  // Nothing to cancel in main: the dialog closes on its own.
  assert.equal(await session.cancel(), false);
  session.dispose();
});
