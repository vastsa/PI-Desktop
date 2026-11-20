/**
 * Contract test for the GitHub connector's IPC surface (ADR
 * github-connector).
 *
 * These seven channels are how the renderer reaches a service that holds the
 * user's GitHub token. The handlers are the boundary: they accept only the
 * main window, check every input before the service sees it, and hand back
 * only the fields the shared contract names — so nothing a service method
 * returns by accident, the token least of all, can ride along.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { registerGitHubConnectorIpc } = await import(
  "../electron/main/ipc/github-connector-ipc.ts"
);

const CHANNELS = {
  status: "pi-desktop/github/status",
  loginStart: "pi-desktop/github/login/start",
  loginCancel: "pi-desktop/github/login/cancel",
  setToken: "pi-desktop/github/setToken",
  disconnect: "pi-desktop/github/disconnect",
  repositories: "pi-desktop/github/repositories",
  branches: "pi-desktop/github/branches",
};
const TOKEN = "gho_ipcFixtureToken";
const MAIN_WINDOW = { sender: { id: 1 } };
const OTHER_WINDOW = { sender: { id: 2 } };

const STATUS = {
  connected: true,
  deviceLoginAvailable: true,
  account: { login: "octocat", name: "The Octocat", avatarUrl: "https://avatars.example/u/1" },
  scopes: ["repo", "read:org"],
  tokenKind: "oauth",
  needsReauthentication: true,
};
const REPOSITORY = {
  owner: "octo-org",
  name: "hello",
  fullName: "octo-org/hello",
  private: true,
  defaultBranch: "main",
  archived: false,
  pushedAt: "2026-11-19T10:00:00Z",
  description: "A repository",
};

/** A connector stand-in whose every answer smuggles the token in extra fields. */
function leakyConnector() {
  const calls = [];
  const leak = { token: TOKEN, credential: { token: TOKEN } };
  const record = (method, value) => async (...args) => {
    calls.push({ method, args });
    return typeof value === "function" ? value(...args) : value;
  };
  const connector = {
    status: record("status", { ...STATUS, account: { ...STATUS.account, ...leak }, ...leak }),
    startDeviceLogin: record("startDeviceLogin", { loginId: "login-1", ...leak }),
    cancelLogin: record("cancelLogin", true),
    setToken: record("setToken", { ...STATUS, ...leak }),
    disconnect: record("disconnect", { connected: false, deviceLoginAvailable: true, ...leak }),
    listRepositories: record("listRepositories", {
      repositories: [{ ...REPOSITORY, ...leak }],
      truncated: true,
      ...leak,
    }),
    listBranches: record("listBranches", {
      branches: [{ name: "main", protected: true, ...leak }],
      defaultBranch: "main",
      truncated: false,
      ...leak,
    }),
    token: record("token", TOKEN),
  };
  return { connector, calls };
}

function setup(connector) {
  const handlers = new Map();
  const plainHandlers = [];
  const registrar = {
    ipcMain: {},
    handle: (channel, handler) => {
      plainHandlers.push(channel);
      handlers.set(channel, (_event, ...args) => handler(...args));
    },
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender: (event) => {
      if (event.sender.id !== MAIN_WINDOW.sender.id) {
        throw Object.assign(new Error("renderer is not the main window"), {
          errorCode: "PERMISSION_DENIED",
        });
      }
    },
  };
  registerGitHubConnectorIpc({ registrar, connector });
  const invoke = (channel, ...args) => handlers.get(channel)(MAIN_WINDOW, ...args);
  return { handlers, plainHandlers, invoke };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the handler to reject");
}

test("exactly the seven connector channels are registered", () => {
  const { connector } = leakyConnector();
  const { handlers } = setup(connector);
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
});

test("each channel calls its service method and returns only contract fields", async () => {
  const { connector, calls } = leakyConnector();
  const { invoke } = setup(connector);

  assert.deepEqual(await invoke(CHANNELS.status), STATUS);
  assert.deepEqual(await invoke(CHANNELS.loginStart, { allowWorkflowScope: true }), {
    loginId: "login-1",
  });
  assert.deepEqual(await invoke(CHANNELS.loginCancel, "login-1"), { ok: true });
  assert.deepEqual(await invoke(CHANNELS.setToken, { token: TOKEN }), STATUS);
  assert.deepEqual(await invoke(CHANNELS.disconnect), {
    connected: false,
    deviceLoginAvailable: true,
  });
  assert.deepEqual(await invoke(CHANNELS.repositories, { query: "hello", refresh: true }), {
    repositories: [REPOSITORY],
    truncated: true,
  });
  assert.deepEqual(await invoke(CHANNELS.branches, { owner: "octo-org", name: "hello" }), {
    branches: [{ name: "main", protected: true }],
    defaultBranch: "main",
    truncated: false,
  });

  assert.deepEqual(calls, [
    { method: "status", args: [] },
    { method: "startDeviceLogin", args: [{ allowWorkflowScope: true }] },
    { method: "cancelLogin", args: ["login-1"] },
    { method: "setToken", args: [TOKEN] },
    { method: "disconnect", args: [] },
    { method: "listRepositories", args: [{ query: "hello", refresh: true }] },
    { method: "listBranches", args: [{ owner: "octo-org", name: "hello" }] },
  ]);
});

test("no channel result contains the token, whatever the service returned", async () => {
  const { connector } = leakyConnector();
  const { invoke } = setup(connector);
  const results = [
    await invoke(CHANNELS.status),
    await invoke(CHANNELS.loginStart, { allowWorkflowScope: false }),
    await invoke(CHANNELS.loginCancel, "login-1"),
    await invoke(CHANNELS.setToken, { token: TOKEN }),
    await invoke(CHANNELS.disconnect),
    await invoke(CHANNELS.repositories, {}),
    await invoke(CHANNELS.branches, { owner: "octo-org", name: "hello" }),
  ];
  assert.equal(JSON.stringify(results).includes(TOKEN), false);
});

test("no handler exposes the main-only token accessor", async () => {
  const { connector, calls } = leakyConnector();
  const { invoke, handlers } = setup(connector);
  for (const channel of handlers.keys()) {
    await invoke(
      channel,
      channel === CHANNELS.loginCancel
        ? "login-1"
        : { allowWorkflowScope: false, token: TOKEN, owner: "octo-org", name: "hello" },
    ).catch(() => undefined);
  }
  assert.equal(calls.some((entry) => entry.method === "token"), false);
});

test("an absent repository filter lists everything, and unknown fields are dropped", async () => {
  const { connector, calls } = leakyConnector();
  const { invoke } = setup(connector);

  await invoke(CHANNELS.repositories);
  await invoke(CHANNELS.repositories, {});
  await invoke(CHANNELS.repositories, { query: "x", host: "evil.example", sessionId: "remote:a:b" });
  await invoke(CHANNELS.branches, { owner: "octo-org", name: "hello", url: "https://evil.example" });
  await invoke(CHANNELS.loginStart, { allowWorkflowScope: false, clientId: "other-app" });
  await invoke(CHANNELS.setToken, { token: TOKEN, kind: "oauth" });

  assert.deepEqual(calls.map((entry) => entry.args), [
    [{}],
    [{}],
    [{ query: "x" }],
    [{ owner: "octo-org", name: "hello" }],
    [{ allowWorkflowScope: false }],
    [TOKEN],
  ]);
});

test("malformed input is refused as INVALID_ARGUMENT before the service is called", async () => {
  const { connector, calls } = leakyConnector();
  const { invoke } = setup(connector);
  const malformed = [
    [CHANNELS.loginStart],
    [CHANNELS.loginStart, null],
    [CHANNELS.loginStart, {}],
    [CHANNELS.loginStart, { allowWorkflowScope: "true" }],
    [CHANNELS.loginStart, { allowWorkflowScope: 1 }],
    [CHANNELS.loginStart, [true]],
    [CHANNELS.loginCancel],
    [CHANNELS.loginCancel, ""],
    [CHANNELS.loginCancel, 7],
    [CHANNELS.loginCancel, { loginId: "login-1" }],
    [CHANNELS.setToken],
    [CHANNELS.setToken, TOKEN],
    [CHANNELS.setToken, {}],
    [CHANNELS.setToken, { token: 42 }],
    [CHANNELS.setToken, { token: null }],
    [CHANNELS.repositories, "hello"],
    [CHANNELS.repositories, []],
    [CHANNELS.repositories, { query: 5 }],
    [CHANNELS.repositories, { refresh: "yes" }],
    [CHANNELS.branches],
    [CHANNELS.branches, "octo-org/hello"],
    [CHANNELS.branches, { owner: "octo-org" }],
    [CHANNELS.branches, { owner: "octo-org", name: 3 }],
    [CHANNELS.branches, { owner: ["octo-org"], name: "hello" }],
  ];
  for (const [channel, ...args] of malformed) {
    const error = await rejection(invoke(channel, ...args));
    assert.equal(error.errorCode, "INVALID_ARGUMENT", `${channel} ${JSON.stringify(args)}`);
    assert.equal(String(error.message).includes(TOKEN), false);
  }
  assert.deepEqual(calls, []);
});

test("only the main window may use the connector", async () => {
  const { connector, calls } = leakyConnector();
  const { handlers, plainHandlers } = setup(connector);

  // Every channel is registered with its sender, so none is reachable through
  // the internal invoke map the local control plane and the remote router use.
  assert.deepEqual(plainHandlers, []);
  for (const [channel, handler] of handlers) {
    const error = await rejection(
      handler(OTHER_WINDOW, { allowWorkflowScope: false, token: TOKEN, owner: "o", name: "n" }),
    );
    assert.equal(error.errorCode, "PERMISSION_DENIED", channel);
  }
  assert.deepEqual(calls, []);
});

test("a service failure reaches the caller unchanged", async () => {
  const { connector } = leakyConnector();
  const failure = Object.assign(new Error("GitHub is rate limiting requests."), {
    errorCode: "GITHUB_RATE_LIMITED",
    data: { errorCode: "GITHUB_RATE_LIMITED", retriable: true },
  });
  connector.listRepositories = async () => {
    throw failure;
  };
  const { invoke } = setup(connector);
  assert.equal(await rejection(invoke(CHANNELS.repositories, {})), failure);
});
