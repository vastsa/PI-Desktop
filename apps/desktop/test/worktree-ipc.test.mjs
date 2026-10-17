import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { registerWorktreeIpc } from "../electron/main/ipc/worktree-ipc.ts";

function setup(responses = {}) {
  const handlers = new Map();
  const calls = [];
  const opened = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      const response = responses[method];
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(params) : response ?? {};
    },
  };
  registerWorktreeIpc({
    registrar: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    getHost: () => host,
    logger: { app: () => {} },
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
    stripWinLongPrefix: (path) => path,
  });
  const invoke = (channel, input) => handlers.get(channel)(input);
  return { invoke, calls, opened };
}

test("reveal opens the host-resolved folder and never returns its path", async () => {
  const { invoke, calls, opened } = setup({
    "worktree.location": { path: "/home/u/.pi-desktop/worktrees/app-1/s1" },
  });
  const result = await invoke(IPC.invoke.worktreeReveal, { sessionId: "s1" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(opened, ["/home/u/.pi-desktop/worktrees/app-1/s1"]);
  assert.deepEqual(calls, [{ method: "worktree.location", params: { sessionId: "s1" } }]);
});

test("preview, merge, and pending work pass the session through and unwrap results", async () => {
  const preview = { previewToken: "t1", commits: [], files: [], conflict: false };
  const { invoke, calls } = setup({
    "worktree.preview": { preview },
    "worktree.merge": { outcome: { result: "merged", commits: 1, files: 2 } },
    "worktree.pendingWork": { pending: { unmergedCommits: 3, uncommittedChanges: true } },
  });
  assert.deepEqual(await invoke(IPC.invoke.worktreePreview, { sessionId: " s1 " }), preview);
  assert.deepEqual(
    await invoke(IPC.invoke.worktreeMerge, { sessionId: "s1", previewToken: "t1" }),
    { result: "merged", commits: 1, files: 2 },
  );
  assert.deepEqual(await invoke(IPC.invoke.worktreePendingWork, { sessionId: "s1" }), {
    unmergedCommits: 3,
    uncommittedChanges: true,
  });
  assert.deepEqual(calls.map((call) => call.params), [
    { sessionId: "s1" },
    { sessionId: "s1", previewToken: "t1" },
    { sessionId: "s1" },
  ]);
});

test("host errors such as a merge conflict reach the caller unchanged", async () => {
  const conflict = Object.assign(new Error("merge conflict in 1 file(s)"), {
    data: { errorCode: "WORKTREE_CONFLICT", files: ["f.txt"] },
  });
  const { invoke } = setup({ "worktree.merge": conflict });
  await assert.rejects(
    invoke(IPC.invoke.worktreeMerge, { sessionId: "s1", previewToken: "t1" }),
    (error) => error.data?.errorCode === "WORKTREE_CONFLICT" && error.data.files[0] === "f.txt",
  );
});

test("missing identifiers and non-string setup commands are rejected before the host", async () => {
  const { invoke, calls } = setup();
  await assert.rejects(invoke(IPC.invoke.worktreePreview, {}), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(invoke(IPC.invoke.worktreeMerge, { sessionId: "s1" }), {
    errorCode: "INVALID_ARGUMENT",
  });
  await assert.rejects(
    invoke(IPC.invoke.worktreeSetupCommandSet, { projectPath: "/p", command: 42 }),
    { errorCode: "INVALID_ARGUMENT" },
  );
  assert.equal(calls.length, 0);

  await invoke(IPC.invoke.worktreeSetupCommandSet, { projectPath: "/p", command: "pnpm i" });
  await invoke(IPC.invoke.worktreeSetupCommandSet, { projectPath: "/p" });
  assert.deepEqual(calls.map((call) => call.params), [
    { projectPath: "/p", command: "pnpm i" },
    { projectPath: "/p", command: null },
  ]);
});

test("sync from project forwards the session and unwraps the count and outcome", async () => {
  const { invoke, calls } = setup({
    "worktree.behind": { commits: 2 },
    "worktree.sync": { outcome: { result: "synced", commits: 2 } },
  });
  assert.equal(await invoke(IPC.invoke.worktreeBehind, { sessionId: "s1" }), 2);
  assert.deepEqual(await invoke(IPC.invoke.worktreeSync, { sessionId: " s1 " }), {
    result: "synced",
    commits: 2,
  });
  assert.deepEqual(calls, [
    { method: "worktree.behind", params: { sessionId: "s1" } },
    { method: "worktree.sync", params: { sessionId: "s1" } },
  ]);
});

test("behind counts for the sidebar pass through unchanged", async () => {
  const behind = { counts: { s1: 2, s2: 0 }, statusesChanged: false };
  const { invoke, calls } = setup({ "worktree.behindAll": behind });
  assert.deepEqual(await invoke(IPC.invoke.worktreeBehindAll), behind);
  assert.deepEqual(calls, [{ method: "worktree.behindAll", params: {} }]);
});
