import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createWorkspaceGitBoot } = await import("../electron/main/remote/workspace-git-boot.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const TOKEN = "fixture-token-not-a-real-credential";
const repository = { owner: "octo", name: "repo" };
const worktree = {
  sessionId: "session-1", repository, baseBranch: "main", workBranch: "pi-desktop/8b54618f6bc1",
  path: "/w/worktrees/github.com/octo/repo/8b54618f6bc1", mainPath: "/w/repos/github.com/octo/repo",
  baseCommit: "a".repeat(40), createdAt: "2026-11-20T00:00:00.000Z", setup: { status: "none" },
};
const ALL = { workspaceTools: true, workspaceFiles: true, workspaceGit: true };
const NO_GIT = { workspaceTools: true, workspaceFiles: true, workspaceGit: false };

/** One connected host behind the boot's dependencies, with every request recorded. */
function setup(options = {}) {
  const requests = [];
  const logs = [];
  const state = {
    capabilities: options.capabilities ?? ALL,
    record: options.record ?? { hostKey: "h", label: "H", url: "wss://host.example", deviceToken: "device" },
    connected: options.connected ?? true,
    realigns: 0,
    readied: 0,
  };
  const host = {
    adapter: {
      client: {
        async request(method, params, timeoutMs) {
          requests.push({ method, params, timeoutMs });
          if (options.respond) return options.respond(method, params);
          return {};
        },
      },
      workspaceCapabilities: () => state.capabilities,
    },
  };
  const boot = createWorkspaceGitBoot({
    connectedHost: (hostKey) => (state.connected && hostKey === state.record.hostKey ? host : undefined),
    ensureReady: async (hostKey) => {
      state.readied += 1;
      if (hostKey !== state.record.hostKey) throw Object.assign(new Error("remote host is unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
      return { hostKey };
    },
    realign: async (hostKey) => {
      state.realigns += 1;
      return options.realign ? options.realign(hostKey, state) : false;
    },
    record: (hostKey) => (hostKey === state.record.hostKey ? state.record : undefined),
    getInstallationId: options.getInstallationId ?? (async () => INSTALLATION),
    log: (level, message, data) => logs.push(JSON.stringify({ level, message, data })),
  });
  return { boot, requests, logs, state, host };
}

const code = (expected) => (error) => (error.errorCode ?? error.code) === expected;

test("every method sends its operation with the installation id and a 30 second budget", async () => {
  const job = { jobId: "job-1", kind: "prepare", state: "running", phase: "queued" };
  const status = { worktree, ahead: 0, behind: 0, uncommittedFiles: 0, unpushedCommits: 0, pushedOnce: false };
  const f = setup({ respond: (method) => ({
    "workspace/gitRepository": { path: worktree.mainPath, cloned: true },
    "workspace/gitPrepare": { jobId: "job-1" },
    "workspace/gitPush": { jobId: "job-2" },
    "workspace/gitJob": job,
    "workspace/gitJobCancel": { ok: true },
    "workspace/gitStatus": status,
    "workspace/gitRemove": { removed: true, uncommittedFiles: 0, unpushedCommits: 0 },
    "workspace/gitList": { worktrees: [worktree] },
  })[method] });
  const environment = { variables: [{ name: "MY_VAR", value: "1" }], setupScript: "true" };

  assert.deepEqual(await f.boot.repository("h", repository), { path: worktree.mainPath, cloned: true });
  assert.deepEqual(await f.boot.prepare("h", { sessionId: "session-1", repository, baseBranch: "main", fromSessionId: "parent", environment }), { jobId: "job-1" });
  assert.deepEqual(await f.boot.prepare("h", { sessionId: "session-2", repository, baseBranch: "develop" }), { jobId: "job-1" });
  assert.deepEqual(await f.boot.push("h", "session-1"), { jobId: "job-2" });
  assert.deepEqual(await f.boot.job("h", "job-1"), job);
  assert.equal(await f.boot.cancelJob("h", "job-1"), undefined);
  assert.deepEqual(await f.boot.status("h", "session-1"), status);
  assert.deepEqual(await f.boot.remove("h", "session-1", true), { removed: true, uncommittedFiles: 0, unpushedCommits: 0 });
  assert.deepEqual(await f.boot.list("h"), [worktree]);

  assert.deepEqual(f.requests, [
    { method: "workspace/gitRepository", params: { repository }, timeoutMs: 30_000 },
    { method: "workspace/gitPrepare", params: { installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "main", fromSessionId: "parent", environment }, timeoutMs: 30_000 },
    { method: "workspace/gitPrepare", params: { installationId: INSTALLATION, sessionId: "session-2", repository, baseBranch: "develop" }, timeoutMs: 30_000 },
    { method: "workspace/gitPush", params: { installationId: INSTALLATION, sessionId: "session-1" }, timeoutMs: 30_000 },
    { method: "workspace/gitJob", params: { jobId: "job-1" }, timeoutMs: 30_000 },
    { method: "workspace/gitJobCancel", params: { jobId: "job-1" }, timeoutMs: 30_000 },
    { method: "workspace/gitStatus", params: { installationId: INSTALLATION, sessionId: "session-1" }, timeoutMs: 30_000 },
    { method: "workspace/gitRemove", params: { installationId: INSTALLATION, sessionId: "session-1", force: true }, timeoutMs: 30_000 },
    { method: "workspace/gitList", params: { installationId: INSTALLATION }, timeoutMs: 30_000 },
  ]);
  // Each call first makes sure the host is connected.
  assert.equal(f.state.readied, 9);
});

test("a caller cannot smuggle its own installation id or extra fields into prepare", async () => {
  const f = setup({ respond: () => ({ jobId: "job-1" }) });
  await f.boot.prepare("h", { sessionId: "s", repository: { ...repository, host: "evil" }, baseBranch: "main", installationId: "11111111-1111-4111-8111-111111111111", path: "/tmp" });
  assert.deepEqual(f.requests[0].params, { installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" });
});

test("automatic removal uses only a live Host that advertises safe removal", async () => {
  const legacy = setup({ capabilities: ALL });
  await assert.rejects(legacy.boot.remove("h", "session-1", false), code("HOST_VERSION_MISMATCH"));
  assert.deepEqual(legacy.requests, []);

  const capable = setup({ capabilities: { ...ALL, workspaceGitSafeRemoval: true } });
  await capable.boot.remove("h", "session-1", false);
  assert.deepEqual(capable.requests.map(({ method }) => method), ["workspace/gitRemove"]);

  const changing = setup({ capabilities: { ...ALL, workspaceGitSafeRemoval: true }, getInstallationId: async () => {
    changing.state.capabilities = ALL;
    return INSTALLATION;
  } });
  await assert.rejects(changing.boot.remove("h", "session-1", false), code("HOST_VERSION_MISMATCH"));
  assert.deepEqual(changing.requests, []);
});

test("a host without the capability is refused before anything is sent", async () => {
  const f = setup({ capabilities: NO_GIT });
  const calls = [
    () => f.boot.repository("h", repository),
    () => f.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" }),
    () => f.boot.push("h", "s"),
    () => f.boot.job("h", "job-1"),
    () => f.boot.cancelJob("h", "job-1"),
    () => f.boot.status("h", "s"),
    () => f.boot.remove("h", "s", false),
    () => f.boot.list("h"),
  ];
  for (const call of calls) await assert.rejects(call(), code("HOST_VERSION_MISMATCH"));
  assert.deepEqual(f.requests, []);
  // An adapter that reports nothing at all is not assumed to support it.
  const silent = setup();
  silent.host.adapter.workspaceCapabilities = undefined;
  await assert.rejects(silent.boot.list("h"), code("HOST_VERSION_MISMATCH"));
  assert.deepEqual(silent.requests, []);
});

test("an unreachable host is unavailable, and a host that changes mid-call is not trusted", async () => {
  const f = setup();
  await assert.rejects(f.boot.list("other"), code("AGENT_UNAVAILABLE"));
  f.state.connected = false;
  await assert.rejects(f.boot.list("h"), code("AGENT_UNAVAILABLE"));
  const swapped = setup({ respond: () => { swapped.state.connected = false; return { worktrees: [worktree] }; } });
  await assert.rejects(swapped.boot.list("h"), code("AGENT_UNAVAILABLE"));
});

test("supported realigns a host that lacks the capability exactly once", async () => {
  const advertised = setup();
  assert.equal(await advertised.boot.supported("h"), true);
  assert.equal(advertised.state.realigns, 0);

  const upgraded = setup({ capabilities: NO_GIT, realign: (_key, state) => { state.capabilities = ALL; return true; } });
  assert.equal(await upgraded.boot.supported("h"), true);
  assert.equal(upgraded.state.realigns, 1);
  assert.equal(await upgraded.boot.supported("h"), true);
  assert.equal(upgraded.state.realigns, 1);

  // A realignment that does not help is reported, and never repeated.
  const stuck = setup({ capabilities: NO_GIT, realign: () => true });
  assert.equal(await stuck.boot.supported("h"), false);
  assert.equal(await stuck.boot.supported("h"), false);
  const [first, second] = await Promise.all([stuck.boot.supported("h"), stuck.boot.supported("h")]);
  assert.deepEqual([first, second], [false, false]);
  assert.equal(stuck.state.realigns, 1);

  const failing = setup({ capabilities: NO_GIT, realign: () => { throw new Error("bootstrap failed"); } });
  assert.equal(await failing.boot.supported("h"), false);
  assert.equal(failing.state.realigns, 1);
  // Two concurrent first calls share one realignment.
  const racing = setup({ capabilities: NO_GIT, realign: async (_key, state) => { await new Promise((resolve) => setTimeout(resolve, 10)); state.capabilities = ALL; return true; } });
  assert.deepEqual(await Promise.all([racing.boot.supported("h"), racing.boot.supported("h")]), [true, true]);
  assert.equal(racing.state.realigns, 1);
  await assert.rejects(setup().boot.supported("other"), code("AGENT_UNAVAILABLE"));
});

test("a connect sends the provider's token, and a null token clears", async () => {
  const f = setup();
  let token = TOKEN;
  f.boot.setCredentialProvider(async () => token);
  await f.boot.hostConnected("h");
  assert.deepEqual(f.requests, [{ method: "workspace/gitCredentialSet", params: { installationId: INSTALLATION, token: TOKEN }, timeoutMs: 30_000 }]);
  token = null;
  await f.boot.refreshCredential();
  assert.deepEqual(f.requests[1], { method: "workspace/gitCredentialClear", params: {}, timeoutMs: 30_000 });
  token = "second-fixture";
  await f.boot.refreshCredential();
  assert.deepEqual(f.requests[2].params, { installationId: INSTALLATION, token: "second-fixture" });
  assert.equal(f.requests.length, 3);
});

test("a missing provider clears credentials and an unsupported host receives nothing", async () => {
  const none = setup();
  await none.boot.hostConnected("h");
  await none.boot.refreshCredential();
  assert.deepEqual(none.requests.map(({ method }) => method), ["workspace/gitCredentialClear", "workspace/gitCredentialClear"]);
  const old = setup({ capabilities: NO_GIT });
  old.boot.setCredentialProvider(async () => TOKEN);
  await old.boot.hostConnected("h");
  await old.boot.refreshCredential();
  assert.deepEqual(old.requests, []);
  // Removing the provider sends a clear instead of a token.
  const removed = setup();
  removed.boot.setCredentialProvider(async () => TOKEN);
  removed.boot.setCredentialProvider(null);
  await removed.boot.hostConnected("h");
  assert.deepEqual(removed.requests.map(({ method }) => method), ["workspace/gitCredentialClear"]);
});

test("the credential is sent only over SSH, wss, or loopback ws", async () => {
  const allowed = [
    { hostKey: "h", label: "H", url: "ws://127.0.0.1:41000", deviceToken: "d", metadata: { transport: "ssh", ssh: { host: "server", remotePort: 4123, version: "1" } } },
    { hostKey: "h", label: "H", url: "wss://x", deviceToken: "d" },
    { hostKey: "h", label: "H", url: "wss://x.example:8443/v1/racp/ws", deviceToken: "d" },
    { hostKey: "h", label: "H", url: "ws://127.0.0.1:1", deviceToken: "d" },
    { hostKey: "h", label: "H", url: "ws://[::1]:1", deviceToken: "d" },
    { hostKey: "h", label: "H", url: "ws://localhost:1", deviceToken: "d" },
  ];
  for (const record of allowed) {
    const f = setup({ record });
    f.boot.setCredentialProvider(async () => TOKEN);
    await f.boot.hostConnected("h");
    assert.deepEqual(f.requests.map((request) => request.method), ["workspace/gitCredentialSet"], record.url);
  }
  const refused = [
    "ws://10.0.0.5:1", "ws://host.example:4123", "ws://127.0.0.1.evil.example:1", "ws://localhost.evil.example:1",
    "ws://[::ffff:10.0.0.5]:1", "http://127.0.0.1:1", "not a url", "ws://127.0.0.2:1",
  ];
  for (const url of refused) {
    const f = setup({ record: { hostKey: "h", label: "H", url, deviceToken: "d" } });
    f.boot.setCredentialProvider(async () => TOKEN);
    await f.boot.hostConnected("h");
    await f.boot.refreshCredential();
    // The request only clears any old credential.
    assert.deepEqual(f.requests.map(({ method }) => method), ["workspace/gitCredentialClear", "workspace/gitCredentialClear"], url);
    // A git session on such a host fails with the typed reason, still without a send.
    await assert.rejects(f.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" }), code("WORKSPACE_GIT_TRANSPORT_REFUSED"), url);
    await assert.rejects(f.boot.push("h", "s"), code("WORKSPACE_GIT_TRANSPORT_REFUSED"), url);
    assert.equal(f.requests.length, 2, url);
    assert.ok(!f.logs.join("\n").includes(TOKEN));
  }
  // With no token to send there is nothing to refuse: the host stays usable.
  const anonymous = setup({ record: { hostKey: "h", label: "H", url: "ws://10.0.0.5:1", deviceToken: "d" }, respond: () => ({ jobId: "job-1" }) });
  anonymous.boot.setCredentialProvider(async () => null);
  await anonymous.boot.hostConnected("h");
  assert.deepEqual(anonymous.requests.map((request) => request.method), ["workspace/gitCredentialClear"]);
  assert.deepEqual(await anonymous.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" }), { jobId: "job-1" });
});

test("a failing provider leaves the host usable and without a credential", async () => {
  const f = setup({ respond: (method) => (method === "workspace/gitList" ? { worktrees: [] } : { jobId: "job-1" }) });
  f.boot.setCredentialProvider(async () => { throw new Error(`keychain failed for ${TOKEN}`); });
  await f.boot.hostConnected("h");
  assert.deepEqual(f.requests.map(({ method }) => method), ["workspace/gitCredentialClear"]);
  assert.deepEqual(await f.boot.list("h"), []);
  assert.deepEqual(await f.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" }), { jobId: "job-1" });
  assert.ok(f.logs.length > 0);
  assert.ok(!f.logs.join("\n").includes(TOKEN));
});

test("neither a log line nor an error ever carries the token", async () => {
  const f = setup({ respond: (method, params) => {
    if (method === "workspace/gitCredentialSet") throw Object.assign(new Error(`host rejected ${params.token}`), { code: "INTERNAL" });
    return {};
  } });
  f.boot.setCredentialProvider(async () => TOKEN);
  await f.boot.hostConnected("h");
  await f.boot.refreshCredential();
  assert.equal(f.requests.filter((request) => request.method === "workspace/gitCredentialSet").length, 2);
  assert.ok(f.logs.length >= 2);
  assert.ok(!f.logs.join("\n").includes(TOKEN));
  // The successful path logs nothing secret either.
  const ok = setup();
  ok.boot.setCredentialProvider(async () => TOKEN);
  await ok.boot.hostConnected("h");
  assert.ok(!ok.logs.join("\n").includes(TOKEN));
});

test("prepare waits for the credential push that a connect started", async () => {
  const order = [];
  const f = setup({ respond: (method) => { order.push(method); return { jobId: "job-1" }; } });
  let release;
  f.boot.setCredentialProvider(() => new Promise((resolve) => { release = () => resolve(TOKEN); }));
  const connected = f.boot.hostConnected("h");
  const prepared = f.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, []);
  release();
  await Promise.all([connected, prepared]);
  assert.deepEqual(order, ["workspace/gitCredentialSet", "workspace/gitPrepare"]);
});

test("an installation id that cannot be loaded fails the call without sending", async () => {
  const f = setup({ getInstallationId: async () => { throw new Error("secret store locked"); } });
  await assert.rejects(f.boot.prepare("h", { sessionId: "s", repository, baseBranch: "main" }));
  await assert.rejects(f.boot.list("h"));
  assert.deepEqual(f.requests, []);
});

// ---- wired into the remote hosts boot ---------------------------------------

function reversibleEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buf) => buf.toString("utf8").slice("enc:".length),
  };
}

function fakeAdapter(capabilities) {
  const requests = [];
  const stateListeners = new Set();
  let state = "disconnected";
  return {
    requests,
    state: () => state,
    emitState(next) { state = next; for (const listener of stateListeners) listener(next); },
    workspaceCapabilities: () => capabilities,
    async connect() { state = "connected"; },
    async close() { state = "disconnected"; },
    client: {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "session/list") return { sessions: [] };
        if (method === "events/subscribe") return { subscriptionId: "sub-host", starting: { epoch: "e1", sequence: 1 }, replayComplete: true };
        if (method === "workspace/gitPrepare") return { jobId: "job-1" };
        return { ok: true };
      },
      subscribe: () => () => undefined,
      subscribeState(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    },
  };
}

async function hostsBoot(adapters, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boot-workspace-git-"));
  const logs = [];
  const boot = createRemoteHostsBoot({
    dataDir: dir, encryption: reversibleEncryption(), router: createBackendRouter(), emit: () => undefined,
    clientInfo: { name: "test", version: "1" }, buildAdapter: (record) => adapters[record.hostKey],
    getInstallationId: async () => INSTALLATION,
    log: (level, message, data) => logs.push(JSON.stringify({ level, message, data })),
    ...extra,
  });
  return { boot, logs, cleanup: async () => { await boot.closeAll(); await rm(dir, { recursive: true, force: true }); } };
}

test("the remote hosts boot sends the credential when a capable host connects or reconnects", async () => {
  const capable = fakeAdapter(ALL);
  const old = fakeAdapter(NO_GIT);
  const { boot, logs, cleanup } = await hostsBoot({ capable, old });
  try {
    boot.workspaceGit.setCredentialProvider(async () => TOKEN);
    await boot.addHost({ hostKey: "capable", label: "Capable", url: "wss://capable", deviceToken: "t" });
    await boot.addHost({ hostKey: "old", label: "Old", url: "wss://old", deviceToken: "t" });
    // A host without the capability still connects and serves folder projects.
    assert.deepEqual((await boot.list()).map((host) => [host.hostKey, host.status]).sort(), [["capable", "connected"], ["old", "connected"]]);
    await boot.workspaceGit.refreshCredential();
    const sets = () => capable.requests.filter((request) => request.method === "workspace/gitCredentialSet");
    assert.ok(sets().length >= 1);
    assert.deepEqual(sets()[0].params, { installationId: INSTALLATION, token: TOKEN });
    assert.equal(old.requests.some((request) => request.method.startsWith("workspace/git")), false);

    // The transport dropped and came back: the new connection needs the token again.
    const before = sets().length;
    capable.emitState("reconnecting");
    capable.emitState("connected");
    await boot.workspaceGit.refreshCredential();
    assert.ok(sets().length > before);

    assert.deepEqual(await boot.workspaceGit.prepare("capable", { sessionId: "s", repository, baseBranch: "main" }), { jobId: "job-1" });
    assert.deepEqual(capable.requests.at(-1), { method: "workspace/gitPrepare", params: { installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" } });
    await assert.rejects(boot.workspaceGit.prepare("old", { sessionId: "s", repository, baseBranch: "main" }), code("HOST_VERSION_MISMATCH"));
    assert.equal(await boot.workspaceGit.supported("capable"), true);
    // No SSH descriptor to realign with: the old host stays as it is, connected.
    assert.equal(await boot.workspaceGit.supported("old"), false);
    assert.equal((await boot.list()).find((host) => host.hostKey === "old").status, "connected");
    assert.ok(!logs.join("\n").includes(TOKEN));
  } finally { await cleanup(); }
});

test("a throwing provider does not fail the host connection", async () => {
  const capable = fakeAdapter(ALL);
  const { boot, logs, cleanup } = await hostsBoot({ capable });
  try {
    boot.workspaceGit.setCredentialProvider(async () => { throw new Error(`boom ${TOKEN}`); });
    const summary = await boot.addHost({ hostKey: "capable", label: "Capable", url: "wss://capable", deviceToken: "t" });
    assert.equal(summary.status, "connected");
    await boot.workspaceGit.refreshCredential();
    assert.equal(capable.requests.some((request) => request.method === "workspace/gitCredentialSet"), false);
    assert.ok(!logs.join("\n").includes(TOKEN));
  } finally { await cleanup(); }
});

test("without an installation identity the git API fails closed and folders keep working", async () => {
  const capable = fakeAdapter(ALL);
  const { boot, cleanup } = await hostsBoot({ capable }, { getInstallationId: undefined });
  try {
    boot.workspaceGit.setCredentialProvider(async () => TOKEN);
    const summary = await boot.addHost({ hostKey: "capable", label: "Capable", url: "wss://capable", deviceToken: "t" });
    assert.equal(summary.status, "connected");
    await boot.workspaceGit.refreshCredential();
    await assert.rejects(boot.workspaceGit.list("capable"), code("WORKSPACE_GIT_UNAVAILABLE"));
    assert.equal(capable.requests.some((request) => request.method.startsWith("workspace/git")), false);
  } finally { await cleanup(); }
});

test("removing a credential provider or losing its store clears the prior remote credential", async () => {
  const f = setup();
  const token = "ghp_fixture_previous";
  f.boot.setCredentialProvider(async () => token);
  await f.boot.hostConnected("h");
  f.boot.setCredentialProvider(async () => { throw new Error("secret store failure"); });
  await f.boot.refreshCredential();
  f.boot.setCredentialProvider(null);
  await f.boot.refreshCredential();
  assert.deepEqual(f.requests.map((request) => request.method), [
    "workspace/gitCredentialSet", "workspace/gitCredentialClear", "workspace/gitCredentialClear",
  ]);
  assert.ok(f.logs.every((line) => !line.includes(token)));
});

test("prepare forwards rerunSetup and works without requiring credential transport", async () => {
  const f = setup({
    record: { hostKey: "h", label: "H", url: "ws://10.0.0.5:8765", deviceToken: "device" },
    respond: (method) => (method === "workspace/gitPrepare" ? { jobId: "job-rerun" } : {}),
  });
  f.boot.setCredentialProvider(async () => TOKEN);
  await f.boot.hostConnected("h");
  const environment = { variables: [{ name: "FOO", value: "bar" }], setupScript: "echo retry" };
  assert.deepEqual(
    await f.boot.prepare("h", {
      sessionId: "session-1",
      repository,
      baseBranch: "main",
      rerunSetup: true,
      environment,
    }),
    { jobId: "job-rerun" },
  );
  assert.deepEqual(f.requests.at(-1), {
    method: "workspace/gitPrepare",
    params: {
      installationId: INSTALLATION,
      sessionId: "session-1",
      repository,
      baseBranch: "main",
      rerunSetup: true,
      environment,
    },
    timeoutMs: 30_000,
  });
});
