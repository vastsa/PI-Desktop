/**
 * Wiring test for the app's GitHub connector (ADR github-connector).
 *
 * `bootGitHubConnector` is where the connector meets the running app: the
 * host-core secret store, the renderer event sink, the guarded external-open
 * helper, and the quit teardown. This pins that the token is read through the
 * host and nowhere else, that a missing host is a failure rather than a
 * signed-out account, and that a committed quit ends a login in progress.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { bootGitHubConnector } = await import("../electron/main/github/connector-boot.ts");
const { getActiveGitHubConnector, setActiveGitHubConnector } = await import(
  "../electron/main/github/connector.ts"
);
const { resetConfirmedQuitForTests, runConfirmedQuitTeardown } = await import(
  "../electron/main/bootstrap/confirmed-quit.ts"
);

const { GITHUB_OAUTH_CLIENT_ID } = await import("@pi-desktop/shared");

const SECRET_REF = "secret:app:github-connector";
const TOKEN = "gho_bootFixtureToken";

function appDeps({ host } = {}) {
  const sent = [];
  const logged = [];
  const opened = [];
  return {
    sent,
    logged,
    opened,
    deps: {
      getHost: () => host ?? null,
      sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
      safeOpenExternal: async (url) => {
        opened.push(url);
      },
      logger: { app: (...args) => logged.push(args) },
    },
  };
}

function hostHolding(value) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "secrets.getForRuntime") return { value };
      return { ok: true };
    },
  };
}

test.afterEach(() => {
  setActiveGitHubConnector(null);
  resetConfirmedQuitForTests();
});

test("the booted connector reads its credential through the host secret store", async () => {
  const host = hostHolding(
    JSON.stringify({
      version: 1,
      token: TOKEN,
      kind: "pat",
      login: "octocat",
      scopes: ["repo"],
      savedAt: "2026-11-20T08:00:00.000Z",
    }),
  );
  const app = appDeps({ host });
  const connector = bootGitHubConnector(app.deps);

  assert.equal(getActiveGitHubConnector(), connector);
  const status = await connector.status();
  assert.equal(status.connected, true);
  assert.equal(status.account.login, "octocat");
  assert.deepEqual(host.calls, [
    { method: "secrets.getForRuntime", params: { secretRef: SECRET_REF } },
  ]);
  assert.equal(await connector.token(), TOKEN);
});

test("status changes go to the renderer, and logs never carry the token", async () => {
  const host = hostHolding(null);
  const app = appDeps({ host });
  const connector = bootGitHubConnector(app.deps);

  await connector.disconnect();

  assert.deepEqual(app.sent, [
    {
      channel: "pi-desktop/github/event/changed",
      // Device login is offered exactly when the build carries a client id.
      payload: {
        connected: false,
        deviceLoginAvailable: Boolean(process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID?.trim() || GITHUB_OAUTH_CLIENT_ID),
      },
    },
  ]);
  assert.deepEqual(host.calls.map((entry) => entry.method), ["secrets.delete"]);
  assert.ok(app.logged.length >= 1);
  for (const [category, level] of app.logged) {
    assert.equal(category, "provider");
    assert.ok(["info", "warn", "error"].includes(level));
  }
  assert.equal(JSON.stringify(app.logged).includes(TOKEN), false);
});

test("a build with a public OAuth client ID offers GitHub device login", async (t) => {
  const previous = process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID;
  process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID = " public-client-id-fixture ";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID;
    else process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID = previous;
  });
  const app = appDeps({ host: hostHolding(null) });
  const connector = bootGitHubConnector(app.deps);

  assert.deepEqual(await connector.status(), { connected: false, deviceLoginAvailable: true });
});

test("a host that is not running is a failure, not a signed-out account", async () => {
  const app = appDeps();
  const connector = bootGitHubConnector(app.deps);

  await assert.rejects(connector.status(), (error) => {
    assert.equal(error.errorCode, "HOST_UNAVAILABLE");
    return true;
  });
  await assert.rejects(connector.listRepositories({}), (error) => {
    assert.equal(error.errorCode, "HOST_UNAVAILABLE");
    return true;
  });
});

test("a committed quit disposes the connector and clears the active handle", async () => {
  const app = appDeps({ host: hostHolding(null) });
  const connector = bootGitHubConnector(app.deps);
  let disposed = 0;
  const dispose = connector.dispose;
  connector.dispose = () => {
    disposed += 1;
    dispose();
  };

  runConfirmedQuitTeardown({ app: () => {} });

  assert.equal(disposed, 1);
  assert.equal(getActiveGitHubConnector(), null);
});
