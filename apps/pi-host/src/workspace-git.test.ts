import { describe, expect, it } from "vitest";
import type { HostRpc } from "@pi-desktop/host-runtime";

import type { GitCredentialProxy, GitProxyScope } from "./git-credential-proxy.js";
import { createWorkspaceGit, workspaceGitShortId, workspaceGitWorkBranch } from "./workspace-git.js";

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const OTHER_INSTALLATION = "11111111-1111-4111-8111-111111111111";
const TOKEN = "fixture-token-not-a-real-credential";
const ROOT = "/home/pi/pi-workspaces";
const repository = { owner: "octo", name: "repo" };
const owner = { deviceId: "device-a", connectionId: "connection-a" };
const ownerB = { deviceId: "device-b", connectionId: "connection-b" };

type Call = { method: string; params: Record<string, unknown> };
type Event = { type: "host"; method: string } | { type: "setToken"; installationId: string; token: string | null } | { type: "register"; scope: GitProxyScope } | { type: "unregister"; installationId: string; sessionId: string };

function worktree(sessionId: string, installationId = INSTALLATION) {
  return {
    sessionId, repository, baseBranch: "main", workBranch: workspaceGitWorkBranch(installationId, sessionId),
    path: `${ROOT}/worktrees/github.com/octo/repo/${workspaceGitShortId(installationId, sessionId)}`,
    mainPath: `${ROOT}/repos/github.com/octo/repo`, baseCommit: "a".repeat(40), createdAt: "2026-11-20T00:00:00.000Z", setup: { status: "none" },
  };
}

function fixture(respond: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {
  const events: Event[] = [];
  const calls: Call[] = [];
  const host: HostRpc = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      events.push({ type: "host", method });
      calls.push({ method, params });
      return respond(method, params) as T;
    },
  };
  const proxy: GitCredentialProxy = {
    async start() {},
    async close() {},
    setToken(installationId, token) { events.push({ type: "setToken", installationId, token }); },
    register(scope) { events.push({ type: "register", scope }); return `http://127.0.0.1:4321/${workspaceGitShortId(scope.installationId, scope.sessionId).padEnd(64, "0")}/`; },
    unregister(installationId, sessionId) { events.push({ type: "unregister", installationId, sessionId }); },
  };
  const state: { host: HostRpc | null } = { host };
  const git = createWorkspaceGit({ getHost: () => state.host, workspacesRoot: ROOT, proxy });
  const urlFor = (sessionId: string, installationId = INSTALLATION) => `http://127.0.0.1:4321/${workspaceGitShortId(installationId, sessionId).padEnd(64, "0")}/`;
  return { git, events, calls, state, host, urlFor };
}

describe("work branch derivation", () => {
  it("matches the cross-language test vector", () => {
    expect(workspaceGitShortId(INSTALLATION, "session-1")).toBe("8b54618f6bc1");
    expect(workspaceGitWorkBranch(INSTALLATION, "session-1")).toBe("pi-desktop/8b54618f6bc1");
    expect(workspaceGitShortId(INSTALLATION, "session-2")).not.toBe("8b54618f6bc1");
    expect(workspaceGitShortId(OTHER_INSTALLATION, "session-1")).not.toBe("8b54618f6bc1");
  });
});

describe("pi-host workspace git", () => {
  it("forwards every operation to host-core with the workspaces root", async () => {
    const job = { jobId: "job-1", kind: "prepare", state: "running", phase: "queued" };
    const status = { worktree: worktree("session-1"), ahead: 0, behind: 0, uncommittedFiles: 0, unpushedCommits: 0, pushedOnce: false };
    const f = fixture((method) => {
      switch (method) {
        case "workspaceGit.repository": return { path: `${ROOT}/repos/github.com/octo/repo`, cloned: true };
        case "workspaceGit.prepare": return { jobId: "job-1" };
        case "workspaceGit.push": return { jobId: "job-2" };
        case "workspaceGit.job": return job;
        case "workspaceGit.jobCancel": return { ok: true };
        case "workspaceGit.status": return status;
        case "workspaceGit.removeSafely": return { removed: false, uncommittedFiles: 2, unpushedCommits: 1 };
        case "workspaceGit.list": return { worktrees: [worktree("session-1")] };
        default: throw new Error(`unexpected ${method}`);
      }
    });
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    expect(await f.git.repository({ repository })).toEqual({ path: `${ROOT}/repos/github.com/octo/repo`, cloned: true });
    expect(await f.git.prepare({ ...session, repository, baseBranch: "main" }, owner)).toEqual({ jobId: "job-1" });
    expect(await f.git.push(session, owner)).toEqual({ jobId: "job-2" });
    expect(await f.git.job({ jobId: "job-1" })).toEqual(job);
    await f.git.cancelJob({ jobId: "job-1" });
    expect(await f.git.status(session)).toEqual(status);
    expect(await f.git.remove({ ...session, force: false })).toEqual({ removed: false, uncommittedFiles: 2, unpushedCommits: 1 });
    expect(await f.git.list({ installationId: INSTALLATION })).toEqual([worktree("session-1")]);
    expect(f.calls.map((call) => call.method)).toEqual([
      "workspaceGit.repository", "workspaceGit.prepare", "workspaceGit.push", "workspaceGit.job", "workspaceGit.jobCancel",
      "workspaceGit.status", "workspaceGit.removeSafely", "workspaceGit.list",
    ]);
    for (const call of f.calls) expect(call.params.workspacesRoot, call.method).toBe(ROOT);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, repository });
    expect(f.calls[3]?.params).toEqual({ workspacesRoot: ROOT, jobId: "job-1" });
    expect(f.calls[5]?.params).toEqual({ workspacesRoot: ROOT, ...session });
    expect(f.calls[6]?.params).toEqual({ workspacesRoot: ROOT, ...session });
    expect(f.calls[7]?.params).toEqual({ workspacesRoot: ROOT, installationId: INSTALLATION });
  });

  it("registers the proxy scope before host-core prepares, and passes its address", async () => {
    const f = fixture(() => ({ jobId: "job-1" }));
    const input = {
      installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "release/1.2", fromSessionId: "parent",
      environment: { variables: [{ name: "MY_VAR", value: "1" }], setupScript: "true" },
    };
    await f.git.prepare(input, owner);
    expect(f.events).toEqual([
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-1", repository, workBranch: "pi-desktop/8b54618f6bc1" } },
      { type: "host", method: "workspaceGit.prepare" },
    ]);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, gitProxy: { url: f.urlFor("session-1") }, ...input });
    // The connection that prepared the session gets the address for its tools.
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    expect(f.git.proxyUrlFor(owner.connectionId, "session-2")).toBeUndefined();
    expect(f.git.proxyUrlFor("connection-unknown", "session-1")).toBeUndefined();
  });

  it("forwards rerunSetup to host-core when requested", async () => {
    const f = fixture(() => ({ jobId: "job-rerun" }));
    const input = {
      installationId: INSTALLATION, sessionId: "session-1", repository, baseBranch: "main",
      rerunSetup: true,
      environment: { variables: [{ name: "MY_VAR", value: "2" }], setupScript: "echo ok" },
    };
    await f.git.prepare(input, owner);
    expect(f.calls[0]?.method).toBe("workspaceGit.prepare");
    expect(f.calls[0]?.params).toEqual({
      workspacesRoot: ROOT,
      gitProxy: { url: f.urlFor("session-1") },
      ...input,
    });
  });

  it("push reuses the session's scope, or finds its repository in the registry", async () => {
    const f = fixture((method) => (method === "workspaceGit.list" ? { worktrees: [worktree("session-9")] } : { jobId: "job-2" }));
    await f.git.push({ installationId: INSTALLATION, sessionId: "session-9" }, owner);
    expect(f.events).toEqual([
      { type: "host", method: "workspaceGit.list" },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-9", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-9") } },
      { type: "host", method: "workspaceGit.push" },
    ]);
    expect(f.calls[1]?.params).toEqual({ workspacesRoot: ROOT, gitProxy: { url: f.urlFor("session-9") }, installationId: INSTALLATION, sessionId: "session-9" });
    // Known now: no second lookup.
    await f.git.push({ installationId: INSTALLATION, sessionId: "session-9" }, owner);
    expect(f.calls.map((call) => call.method)).toEqual(["workspaceGit.list", "workspaceGit.push", "workspaceGit.push"]);
    // A session without a worktree has nothing to push, and host-core is not asked to.
    await expect(f.git.push({ installationId: INSTALLATION, sessionId: "no-such" }, owner)).rejects.toMatchObject({ code: "WORKSPACE_GIT_NOT_FOUND" });
    expect(f.calls.at(-1)?.method).toBe("workspaceGit.list");
  });

  it("setCredential hands the token to the proxy and scopes every existing worktree", async () => {
    const f = fixture((method, params) => (method === "workspaceGit.list" ? { worktrees: params.installationId === INSTALLATION ? [worktree("session-1"), worktree("session-2")] : [] } : {}));
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    expect(f.events).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "host", method: "workspaceGit.list" },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-1", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-1") } },
      { type: "register", scope: { installationId: INSTALLATION, sessionId: "session-2", repository, workBranch: workspaceGitWorkBranch(INSTALLATION, "session-2") } },
    ]);
    expect(f.calls[0]?.params).toEqual({ workspacesRoot: ROOT, installationId: INSTALLATION });
    expect(f.git.proxyUrlFor(owner.connectionId, "session-2")).toBe(f.urlFor("session-2"));
    // Another desktop's connection does not get this installation's address.
    await f.git.setCredential({ installationId: OTHER_INSTALLATION, token: "other-fixture" }, ownerB);
    expect(f.git.proxyUrlFor(ownerB.connectionId, "session-2")).toBeUndefined();
    // The token goes to the proxy and nowhere else.
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
  });

  it("drops the token when the last connection that set it clears it or disconnects", async () => {
    const f = fixture((method) => (method === "workspaceGit.list" ? { worktrees: [worktree("session-1")] } : {}));
    const tokens = () => f.events.filter((event) => event.type === "setToken");
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, ownerB);
    expect(tokens()).toHaveLength(2);
    await f.git.disconnect(owner.connectionId);
    // One of two: the installation still has a live connection.
    expect(tokens()).toHaveLength(2);
    await f.git.clearCredential(ownerB);
    expect(tokens().at(-1)).toEqual({ type: "setToken", installationId: INSTALLATION, token: null });
    // The cleared connection keeps its address, so its git fails closed at the
    // proxy instead of going to GitHub without one.
    expect(f.git.proxyUrlFor(ownerB.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBeUndefined();

    // The only connection: disconnect clears.
    const g = fixture(() => ({ worktrees: [] }));
    await g.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await g.git.disconnect(owner.connectionId);
    expect(g.events.filter((event) => event.type === "setToken")).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "setToken", installationId: INSTALLATION, token: null },
    ]);
    // A request that arrives for a connection that is already gone sets nothing.
    await expect(g.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(g.events.filter((event) => event.type === "setToken")).toHaveLength(2);
    // Clearing or disconnecting twice is harmless.
    await g.git.clearCredential(owner);
    await g.git.disconnect(owner.connectionId);
    await g.git.disconnect("never-seen");
    expect(g.events.filter((event) => event.type === "setToken")).toHaveLength(2);
  });

  it("moves a connection that changes installation and replaces its token", async () => {
    const f = fixture(() => ({ worktrees: [] }));
    await f.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner);
    await f.git.setCredential({ installationId: OTHER_INSTALLATION, token: "other-fixture" }, owner);
    expect(f.events.filter((event) => event.type === "setToken")).toEqual([
      { type: "setToken", installationId: INSTALLATION, token: TOKEN },
      { type: "setToken", installationId: INSTALLATION, token: null },
      { type: "setToken", installationId: OTHER_INSTALLATION, token: "other-fixture" },
    ]);
  });

  it("does not fall back to legacy removal when host-core lacks guarded removal", async () => {
    const f = fixture((method) => {
      if (method === "workspaceGit.removeSafely") {
        throw Object.assign(new Error("method not found"), { data: { errorCode: "METHOD_NOT_FOUND" } });
      }
      return { removed: true, uncommittedFiles: 0, unpushedCommits: 0 };
    });
    await expect(f.git.remove({ installationId: INSTALLATION, sessionId: "session-1", force: false }))
      .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(f.calls.map(({ method }) => method)).toEqual(["workspaceGit.removeSafely"]);
  });

  it("drops the scope once host-core has removed the worktree", async () => {
    let removed = false;
    const f = fixture((method) => (["workspaceGit.remove", "workspaceGit.removeSafely"].includes(method) ? { removed, uncommittedFiles: 1, unpushedCommits: 0 } : { jobId: "job-1" }));
    const session = { installationId: INSTALLATION, sessionId: "session-1" };
    await f.git.prepare({ ...session, repository, baseBranch: "main" }, owner);
    await f.git.remove({ ...session, force: false });
    expect(f.events.some((event) => event.type === "unregister")).toBe(false);
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBe(f.urlFor("session-1"));
    removed = true;
    await f.git.remove({ ...session, force: true });
    expect(f.events.at(-1)).toEqual({ type: "unregister", ...session });
    expect(f.git.proxyUrlFor(owner.connectionId, "session-1")).toBeUndefined();
  });

  it("surfaces host-core's typed errors and never reports a restarted host as success", async () => {
    const busy = fixture(() => { throw Object.assign(new Error("a git job for this session is still running"), { data: { errorCode: "WORKSPACE_GIT_BUSY" } }); });
    await expect(busy.git.prepare({ installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" }, owner)).rejects.toMatchObject({ code: "WORKSPACE_GIT_BUSY", message: "a git job for this session is still running" });
    await expect(busy.git.job({ jobId: "x" })).rejects.toMatchObject({ code: "WORKSPACE_GIT_BUSY" });
    const invalid = fixture(() => { throw Object.assign(new Error("branch name is not an allowed git branch name"), { errorCode: "INVALID_ARGUMENT" }); });
    await expect(invalid.git.status({ installationId: INSTALLATION, sessionId: "s" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const down = fixture(() => { throw Object.assign(new Error("host exited"), { errorCode: "HOST_UNAVAILABLE" }); });
    await expect(down.git.list({ installationId: INSTALLATION })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    const other = fixture(() => { throw new Error("boom"); });
    await expect(other.git.list({ installationId: INSTALLATION })).rejects.toMatchObject({ code: "INTERNAL" });

    const none = fixture();
    none.state.host = null;
    await expect(none.git.repository({ repository })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    await expect(none.git.setCredential({ installationId: INSTALLATION, token: TOKEN }, owner)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(none.events).toEqual([]);

    // host-core was replaced while the call was in flight.
    const restarted = fixture();
    restarted.state.host = { async call<T>() { restarted.state.host = { async call<U>() { return {} as U; } }; return { jobId: "stale" } as T; } };
    await expect(restarted.git.prepare({ installationId: INSTALLATION, sessionId: "s", repository, baseBranch: "main" }, owner)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});
