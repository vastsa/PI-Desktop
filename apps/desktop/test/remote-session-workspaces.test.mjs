import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ErrorCodes, IPC } = await import("@pi-desktop/shared");
const { createSessionWorkspaces } = await import("../electron/main/remote/session-workspaces.ts");

const repository = { owner: "octo", name: "repo" };

function createFixture(options = {}) {
  const bindings = new Map(Object.entries(options.bindings ?? {}));
  let storedEnvironments = [...(options.environments ?? [
    {
      id: "env-1",
      name: "Dev",
      hostKey: "h1",
      setupScript: "npm ci",
      variables: [{ name: "NODE_ENV", value: "development" }],
    },
  ])];
  const events = [];
  const prepareCalls = [];
  const jobResponses = [...(options.jobResponses ?? [])];
  let jobCounter = 0;

  const workspaceGit = {
    async prepare(hostKey, input) {
      prepareCalls.push({ hostKey, input });
      jobCounter += 1;
      return { jobId: `job-${jobCounter}` };
    },
    async job(_hostKey, jobId) {
      const next = jobResponses.shift();
      if (!next) throw new Error(`unexpected job poll for ${jobId}`);
      return typeof next === "function" ? next(jobId) : next;
    },
    async cancelJob() {},
    async list() { return []; },
  };

  const workspaces = createSessionWorkspaces({
    async call(method, params = {}) {
      switch (method) {
        case "sessionWorkspace.get":
          return { binding: bindings.get(params.sessionId) ?? null };
        case "sessionWorkspace.update": {
          const current = bindings.get(params.sessionId);
          if (!current) throw new Error(`missing binding ${params.sessionId}`);
          const next = { ...current, ...params.patch };
          bindings.set(params.sessionId, next);
          return { binding: next };
        }
        case "sessionWorkspace.list":
          return { bindings: [...bindings.values()] };
        case "environments.list":
          return { environments: storedEnvironments };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
    hosts: () => ({
      async list() {
        return [{ hostKey: "h1", label: "Build host", connected: true }];
      },
      workspaceGit,
    }),
    connector: {
      async status() { return { connected: true, needsReauthentication: false }; },
    },
    emit(channel, payload) {
      events.push({ channel, payload });
    },
    log(message, error) {
      throw new Error(`${message}: ${error}`);
    },
  });

  return {
    workspaces,
    bindings,
    events,
    prepareCalls,
    setEnvironments(next) { storedEnvironments = next; },
  };
}

test("retry on failed setup reruns setup with latest environment and streams live setupLogTail", async () => {
  const worktree = {
    sessionId: "s-1",
    repository,
    baseBranch: "main",
    workBranch: "pi-desktop/abc123",
    path: "/w/worktrees/github.com/octo/repo/abc123",
    mainPath: "/w/repos/github.com/octo/repo",
    baseCommit: "a".repeat(40),
    createdAt: "2026-11-20T00:00:00.000Z",
    setup: { status: "ok", logTail: "step 1\nstep 2\ndone" },
  };
  const f = createFixture({
    bindings: {
      "s-1": {
        sessionId: "s-1",
        environmentId: "env-1",
        hostKey: "h1",
        repository,
        baseBranch: "main",
        workBranch: worktree.workBranch,
        path: worktree.path,
        state: "ready",
        setup: { status: "failed", logTail: "old error log" },
      },
    },
    jobResponses: [
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup" },
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup", setupLogTail: "step 1\n" },
      { jobId: "job-1", kind: "prepare", state: "running", phase: "runningSetup", setupLogTail: "step 1\nstep 2\n" },
      { jobId: "job-1", kind: "prepare", state: "succeeded", phase: "done", worktree },
    ],
  });

  try {
    const started = await f.workspaces.retry("s-1");
    assert.equal(started.state, "preparing");
    await f.workspaces.waitUntilReady("s-1");

    assert.equal(f.prepareCalls.length, 1);
    assert.deepEqual(f.prepareCalls[0], {
      hostKey: "h1",
      input: {
        sessionId: "s-1",
        repository,
        baseBranch: "main",
        rerunSetup: true,
        environment: {
          variables: [{ name: "NODE_ENV", value: "development" }],
          setupScript: "npm ci",
        },
      },
    });

    const workspaceEvents = f.events
      .filter((entry) => entry.channel === IPC.event.remoteSessionWorkspaceChanged)
      .map((entry) => entry.payload.remoteRepository);

    // During runningSetup before any output, stale failed log must not leak.
    const initialSetupEvent = workspaceEvents.find((item) => item.phase === "runningSetup" && !item.setup?.logTail);
    assert.ok(initialSetupEvent, "expected runningSetup phase event");
    assert.deepEqual(initialSetupEvent.setup, { status: "running" });

    // Live setupLogTail updates each emit a workspaceChanged event.
    const liveLogs = workspaceEvents
      .filter((item) => item.phase === "runningSetup" && item.setup?.logTail)
      .map((item) => item.setup);
    assert.deepEqual(liveLogs, [
      { status: "running", logTail: "step 1\n" },
      { status: "running", logTail: "step 1\nstep 2\n" },
    ]);

    const final = await f.workspaces.get("s-1");
    assert.equal(final?.state, "ready");
    assert.deepEqual(final?.setup, { status: "ok", logTail: "step 1\nstep 2\ndone" });
  } finally {
    f.workspaces.dispose();
  }
});

test("retry on failed setup falls back to omitting environment when deleted and rejects ok workspaces", async () => {
  const worktree = {
    sessionId: "s-2",
    repository,
    baseBranch: "main",
    workBranch: "pi-desktop/def456",
    path: "/w/worktrees/github.com/octo/repo/def456",
    mainPath: "/w/repos/github.com/octo/repo",
    baseCommit: "b".repeat(40),
    createdAt: "2026-11-20T00:00:00.000Z",
    setup: { status: "ok" },
  };
  const f = createFixture({
    environments: [],
    bindings: {
      "s-2": {
        sessionId: "s-2",
        environmentId: "deleted-env",
        hostKey: "h1",
        repository,
        baseBranch: "main",
        workBranch: worktree.workBranch,
        path: worktree.path,
        state: "ready",
        setup: { status: "failed", logTail: "boom" },
      },
    },
    jobResponses: [
      { jobId: "job-1", kind: "prepare", state: "succeeded", phase: "done", worktree },
    ],
  });

  try {
    await f.workspaces.retry("s-2");
    await f.workspaces.waitUntilReady("s-2");
    assert.deepEqual(f.prepareCalls[0], {
      hostKey: "h1",
      input: {
        sessionId: "s-2",
        repository,
        baseBranch: "main",
        rerunSetup: true,
      },
    });
    await assert.rejects(
      f.workspaces.retry("s-2"),
      (error) => error.errorCode === ErrorCodes.CONFLICT,
    );
  } finally {
    f.workspaces.dispose();
  }
});
