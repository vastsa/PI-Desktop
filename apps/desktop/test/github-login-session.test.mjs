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
const { githubErrorText } = await import(
  "../src/features/settings/connectors/github-error-message.ts"
);
const { catalogs, flattenCatalog } = await import("@pi-desktop/i18n");
const { GITHUB_DEVICE_WAITING_MESSAGE } = await import("@pi-desktop/shared");

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

/** A translator over a real catalog, with i18next's defaultValue fallback. */
function translator(locale) {
  const flat = flattenCatalog(catalogs[locale]);
  return (key, options) => flat[key] ?? options?.defaultValue ?? key;
}

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

test("a GitHub error code is shown in the user's language, not in main's English", () => {
  for (const locale of ["en", "de", "zh-CN"]) {
    const t = translator(locale);
    const flat = flattenCatalog(catalogs[locale]);
    for (const code of ["GITHUB_INVALID_TOKEN", "GITHUB_AUTH_FAILED", "GITHUB_RATE_LIMITED"]) {
      const error = Object.assign(new Error("main-process English sentence"), { code });
      assert.equal(githubErrorText(t, error), flat[`errors.${code}`], `${locale} ${code}`);
    }
  }
  assert.notEqual(
    githubErrorText(translator("de"), { code: "GITHUB_INVALID_TOKEN", message: "x" }),
    githubErrorText(translator("en"), { code: "GITHUB_INVALID_TOKEN", message: "x" }),
  );
});

test("an unknown or absent code falls back to the message main sent", () => {
  const t = translator("de");
  assert.equal(
    githubErrorText(t, Object.assign(new Error("host unavailable"), { code: "SOME_NEW_CODE" })),
    "host unavailable",
  );
  assert.equal(githubErrorText(t, new Error("no code at all")), "no code at all");
  assert.equal(githubErrorText(t, "a bare string"), "a bare string");
  // A code outside the connector's own set is not looked up here, even if the
  // catalog happens to have a sentence for it.
  assert.equal(
    githubErrorText(t, Object.assign(new Error("from main"), { code: "HOST_UNAVAILABLE" })),
    "from main",
  );
});

test("the dialog receives localized login errors and the localized waiting line", async () => {
  const t = translator("de");
  const flat = flattenCatalog(catalogs.de);
  const fake = connectorApi();
  const session = beginGitHubLogin(fake.api, { allowWorkflowScope: false, t });
  const seen = [];
  session.subscribe((entry) => seen.push(entry));
  await new Promise((resolve) => setImmediate(resolve));

  fake.emit(event("login-1", { kind: "progress", message: GITHUB_DEVICE_WAITING_MESSAGE }));
  fake.emit(event("login-1", { kind: "progress", message: "something else from main" }));
  fake.emit(
    event("login-1", {
      kind: "error",
      message: "The sign-in was declined on GitHub.",
      code: "GITHUB_LOGIN_DENIED",
    }),
  );
  fake.emit(event("login-1", { kind: "error", message: "unexpected", code: "NOT_A_GITHUB_CODE" }));
  fake.emit(event("login-1", { kind: "error", message: "no code" }));

  assert.deepEqual(seen.map((entry) => entry.message), [
    flat["settings.connectors.github.waitingForApproval"],
    "something else from main",
    flat["errors.GITHUB_LOGIN_DENIED"],
    "unexpected",
    "no code",
  ]);
  assert.notEqual(flat["errors.GITHUB_LOGIN_DENIED"], "The sign-in was declined on GitHub.");
  session.dispose();
});

test("a login that could not start is reported in the user's language", async () => {
  const fake = connectorApi({
    start: async () => {
      throw Object.assign(new Error("Sign-in with a code is not configured in this build."), {
        code: "GITHUB_DEVICE_FLOW_UNAVAILABLE",
      });
    },
  });
  const session = beginGitHubLogin(fake.api, {
    allowWorkflowScope: false,
    t: translator("zh-CN"),
  });
  const seen = [];
  session.subscribe((entry) => seen.push(entry));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "error");
  assert.equal(
    seen[0].message,
    flattenCatalog(catalogs["zh-CN"])["errors.GITHUB_DEVICE_FLOW_UNAVAILABLE"],
  );
  session.dispose();
});
