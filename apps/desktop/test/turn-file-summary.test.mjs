import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { summarizeTurnFileChanges } = await import(
  "../src/lib/turn-file-summary.ts"
);
const { createWorkPanelSlice } = await import("../src/stores/slices/work-panel-slice.ts");
const { transcriptViewMessages } = await import("../src/lib/transcript-reading.ts");
const { createTranscriptSlice } = await import("../src/stores/slices/transcript-slice.ts");
const { createTranscriptReadingRuntime } = await import("../src/stores/runtime/transcript-reading-runtime.ts");
const { api } = await import("../src/lib/api.ts");
const { reviewChangesFromMessage } = await import("../src/lib/workspace-review.ts");

const message = (id, role, extra = {}) => ({
  id,
  role,
  content: "",
  createdAt: "2026-09-20T00:00:00.000Z",
  ...extra,
});

const review = (snapshotId, path, extra = {}) => ({
  version: 1,
  snapshotId,
  messageId: `message-${snapshotId}`,
  path,
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 2,
  deletions: 1,
  hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "next" }] }],
  reversible: true,
  ...extra,
});

const tool = (id, toolName, details, extra = {}) =>
  message(id, "tool", {
    toolName,
    toolStatus: "success",
    toolCallId: `call-${id}`,
    toolResult: { details },
    ...extra,
  });

const turnEntries = (messages) =>
  buildTranscriptEntries(messages).entries.filter(
    (entry) => entry.kind === "assistant-turn",
  );

const workspaceEdit = (id, snapshotId, path, extraReview = {}, extraMessage = {}) =>
  tool(
    id,
    "Edit",
    { root: "workspace", review: review(snapshotId, path, extraReview) },
    extraMessage,
  );

const shell = (id, reviews, capture = "complete", extra = {}) =>
  tool(
    id,
    "Bash",
    {
      root: "workspace",
      exitCode: 0,
      reviews,
      reviewCapture: { status: capture },
    },
    extra,
  );

test("visual turns are summarized independently without round contamination", () => {
  const [first, second] = turnEntries([
    message("user-1", "user"),
    workspaceEdit("edit-1", "snapshot-1", "src/first.ts"),
    message("answer-1", "assistant", { content: "First done" }),
    message("user-2", "user"),
    shell("shell-2", [review("snapshot-2", "src/second.ts")]),
    message("answer-2", "assistant", { content: "Second done" }),
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(first).files.map((file) => file.path),
    ["src/first.ts"],
  );
  assert.deepEqual(
    summarizeTurnFileChanges(second).files.map((file) => file.path),
    ["src/second.ts"],
  );
});

test("screenshot workflow records the three Bash-copied workspace files", () => {
  const failedWrite = tool(
    "workspace-write",
    "Write",
    { root: "workspace", review: review("failed-write", "index.html") },
    { toolStatus: "error" },
  );
  const scratchWrite = tool("scratch-write", "Write", {
    root: "scratch",
    review: review("scratch-write", "index.html"),
  });
  const copied = shell("copy-files", [
    review("shell-html", "index.html", { additions: 20, deletions: 0 }),
    review("shell-css", "styles.css", { additions: 12, deletions: 0 }),
    review("shell-js", "app.js", { additions: 8, deletions: 0 }),
  ]);
  const [entry] = turnEntries([
    failedWrite,
    scratchWrite,
    copied,
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 3);
  assert.equal(summary.operationCount, 3);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["app.js", "styles.css", "index.html"],
  );
  assert.equal(summary.hasCompleteCapture, true);
  assert.equal(summary.hasUnavailableCapture, false);
});

test("repeated paths group operations and dedupe repeated snapshots", () => {
  const [entry] = turnEntries([
    workspaceEdit("early", "snapshot-early", "src/repeated.ts", {
      additions: 3,
      deletions: 0,
    }),
    shell("copy", [
      review("snapshot-other", "src/other.ts", { additions: 1, deletions: 4 }),
      review("snapshot-late", "src/repeated.ts", { additions: 5, deletions: 2 }),
      review("snapshot-late", "src/repeated.ts", { additions: 6, deletions: 2 }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 2);
  assert.equal(summary.operationCount, 3);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["src/repeated.ts", "src/other.ts"],
  );
  assert.deepEqual(
    summary.files[0].entries.map((record) => record.change.snapshotId),
    ["snapshot-late", "snapshot-early"],
  );
  assert.deepEqual([summary.additions, summary.deletions], [10, 6]);
});

test("failed Bash still contributes valid captured mutations", () => {
  const [entry] = turnEntries([
    shell(
      "failed-shell",
      [review("failed-shell-change", "partial-output.html")],
      "partial",
      { toolStatus: "error" },
    ),
    message("answer", "assistant", { content: "Command failed" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 1);
  assert.equal(summary.files[0].path, "partial-output.html");
  assert.equal(summary.hasPartialCapture, true);
});

test("complete no-change shell captures do not create an empty summary", () => {
  const [entry] = turnEntries([
    shell("read-only", []),
    message("answer", "assistant", { content: "No changes" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 0);
  assert.equal(summary.hasCompleteCapture, true);
  assert.equal(summary.hasPartialCapture, false);
  assert.equal(summary.hasUnavailableCapture, false);
});

test("partial and legacy shell scope remain visible without invented files", () => {
  const [partialEntry] = turnEntries([
    shell("partial", [], "partial"),
    message("partial-answer", "assistant", { content: "Partial" }),
  ]);
  const [legacyEntry] = turnEntries([
    tool("legacy", "Bash", { exitCode: 0 }),
    message("legacy-answer", "assistant", { content: "Legacy" }),
  ]);

  assert.equal(summarizeTurnFileChanges(partialEntry).hasPartialCapture, true);
  assert.equal(summarizeTurnFileChanges(legacyEntry).hasUnavailableCapture, true);
  assert.equal(summarizeTurnFileChanges(legacyEntry).fileCount, 0);
});

test("rolled-back records stay visible but leave active totals", () => {
  const [entry] = turnEntries([
    shell("changes", [
      review("snapshot-rolled", "src/a.ts", {
        state: "rolledBack",
        additions: 8,
        deletions: 3,
      }),
      review("snapshot-active", "src/a.ts", { additions: 2, deletions: 1 }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.operationCount, 2);
  assert.equal(summary.activeOperationCount, 1);
  assert.equal(summary.rolledBackOperationCount, 1);
  assert.deepEqual([summary.additions, summary.deletions], [2, 1]);
});

test("binary and truncated records remain available without line hunks", () => {
  const [entry] = turnEntries([
    shell("binary-shell", [
      review("snapshot-binary", "asset.bin", {
        binary: true,
        hunks: [],
        additions: 0,
        deletions: 0,
      }),
      review("snapshot-large", "generated.txt", {
        truncated: true,
        hunks: [],
        additions: 100,
        deletions: 20,
      }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.files.find((file) => file.path === "asset.bin").entries[0].change.binary, true);
  assert.equal(summary.files.find((file) => file.path === "generated.txt").entries[0].change.truncated, true);
});

test("Task-owned delegate edits are included while parent Bash .gradle caches are hidden", () => {
  const task = tool("task", "Task", { status: "running" });
  const delegateEdits = Array.from({ length: 6 }, (_, index) =>
    workspaceEdit(
      `delegate-${index + 1}`,
      `snapshot-delegate-${index + 1}`,
      `src/delegate-${index + 1}.ts`,
      {},
      { parentToolCallId: "call-task", agentName: "fixer" },
    ),
  );
  const caches = shell(
    "parent-build",
    Array.from({ length: 7 }, (_, index) =>
      review(`cache-${index + 1}`, `.gradle/caches/cache-${index + 1}.bin`, {
        binary: true,
        additions: 0,
        deletions: 0,
      }),
    ),
  );
  const direct = workspaceEdit("direct", "snapshot-direct", "src/direct.ts");
  const [entry] = turnEntries([
    task,
    ...delegateEdits,
    caches,
    direct,
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 7);
  assert.equal(summary.files.some((file) => file.path.includes(".gradle")), false);
  assert.deepEqual(
    new Set(summary.files.map((file) => file.path)),
    new Set(["src/direct.ts", ...delegateEdits.map((_, index) => `src/delegate-${index + 1}.ts`)]),
  );
  assert.equal(
    summary.files.find((file) => file.path === "src/delegate-1.ts").entries[0].message,
    delegateEdits[0],
  );
  assert.equal(summary.hasBashTool, true);
});

test("delayed delegate records remain owned by their Task turn", () => {
  const task = tool("task", "Task", { status: "running" });
  const delayed = workspaceEdit(
    "delayed",
    "snapshot-delayed",
    "src/delayed.ts",
    {},
    { parentToolCallId: "call-task", agentName: "fixer" },
  );
  const [first, second] = turnEntries([
    message("user-1", "user"),
    task,
    message("answer-1", "assistant", { content: "Delegated" }),
    message("user-2", "user"),
    message("answer-2", "assistant", { content: "Later turn" }),
    delayed,
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(first).files.map((file) => file.path),
    ["src/delayed.ts"],
  );
  assert.equal(summarizeTurnFileChanges(second).fileCount, 0);
});

test("resumed delegate edits stay with their original Task turns", () => {
  const firstTask = tool("task-1", "Task", { delegationId: "delegate-1" });
  const firstEdit = workspaceEdit(
    "delegate-first",
    "snapshot-first",
    "src/first-delegate.ts",
    {},
    { parentToolCallId: "call-task-1", agentName: "fixer" },
  );
  const secondTask = tool(
    "task-2",
    "Task",
    { delegationId: "delegate-2" },
    { toolArgs: { resume: "delegate-1" } },
  );
  const secondEdit = workspaceEdit(
    "delegate-second",
    "snapshot-second",
    "src/second-delegate.ts",
    {},
    { parentToolCallId: "call-task-2", agentName: "fixer" },
  );
  const [first, second] = turnEntries([
    message("user-1", "user"),
    firstTask,
    firstEdit,
    message("answer-1", "assistant", { content: "First pass" }),
    message("user-2", "user"),
    secondTask,
    secondEdit,
    message("answer-2", "assistant", { content: "Second pass" }),
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(first).files.map((file) => file.path),
    ["src/first-delegate.ts"],
  );
  assert.deepEqual(
    summarizeTurnFileChanges(second).files.map((file) => file.path),
    ["src/second-delegate.ts"],
  );
});

test("same-turn resume groups original Task ownership without duplicating files", () => {
  const [entry] = turnEntries([
    message("user", "user"),
    tool("task-1", "Task", { delegationId: "delegate-1" }),
    workspaceEdit(
      "delegate-first",
      "snapshot-first",
      "src/first.ts",
      {},
      { parentToolCallId: "call-task-1" },
    ),
    tool(
      "task-2",
      "Task",
      { delegationId: "delegate-2" },
      { toolArgs: { resume: "delegate-1" } },
    ),
    workspaceEdit(
      "delegate-second",
      "snapshot-second",
      "src/second.ts",
      {},
      { parentToolCallId: "call-task-2" },
    ),
    message("answer", "assistant", { content: "Done" }),
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(entry).files.map((file) => file.path),
    ["src/second.ts", "src/first.ts"],
  );
});

test("interleaved parent and delegate edits keep raw latest-first snapshot order", () => {
  const path = "src/shared.ts";
  const [entry] = turnEntries([
    message("user", "user"),
    tool("task", "Task", { status: "running" }),
    workspaceEdit(
      "delegate-early",
      "snapshot-delegate-early",
      path,
      {},
      { parentToolCallId: "call-task" },
    ),
    workspaceEdit("parent-middle", "snapshot-parent-middle", path),
    workspaceEdit(
      "delegate-late",
      "snapshot-delegate-late",
      path,
      {},
      { parentToolCallId: "call-task" },
    ),
    message("answer", "assistant", { content: "Done" }),
  ]);

  assert.deepEqual(
    summarizeTurnFileChanges(entry).files[0].entries.map(
      (record) => record.change.snapshotId,
    ),
    [
      "snapshot-delegate-late",
      "snapshot-parent-middle",
      "snapshot-delegate-early",
    ],
  );
});

test("orphan delegate records are not attached to an unrelated Task turn", () => {
  const [entry] = turnEntries([
    tool("task", "Task", { status: "running" }),
    workspaceEdit(
      "orphan",
      "snapshot-orphan",
      "src/orphan.ts",
      {},
      { parentToolCallId: "call-missing-task", agentName: "fixer" },
    ),
    message("answer", "assistant", { content: "Done" }),
  ]);

  assert.equal(summarizeTurnFileChanges(entry).fileCount, 0);
});

test("malformed and legacy records keep the same counts without exposing hunks", () => {
  const hunks = Array.from({ length: 8 }, (_, index) => ({
    header: `@@ -${index} +${index} @@`,
    lines: [{ type: "add", text: `line-${index}` }],
  }));
  const [entry] = turnEntries([
    shell("mixed", [
      { version: 2, snapshotId: "legacy", path: "legacy.ts" },
      { ...review("invalid", "bad.ts"), additions: -1 },
      review("ok", "src/ok.ts", { hunks, additions: 4, deletions: 0 }),
      review("ok", "src/ok.ts", { hunks, additions: 7, deletions: 2 }),
    ]),
    message("answer", "assistant", { content: "Done" }),
  ]);
  const summary = summarizeTurnFileChanges(entry);

  assert.equal(summary.fileCount, 1);
  assert.equal(summary.operationCount, 1);
  assert.equal(summary.files[0].path, "src/ok.ts");
  assert.equal(summary.files[0].entries[0].change.snapshotId, "ok");
  assert.deepEqual([summary.additions, summary.deletions], [7, 2]);
  assert.equal("hunks" in summary.files[0].entries[0].change, false);
});

function reviewStore(messages, overrides = {}, pending = false) {
  let state = {
    activeSessionId: "session-a", messages, sessionCompactions: {}, transcriptViews: {},
    workPanelOpen: false, workPanelTabs: [], activeWorkPanelTabId: null,
    workPanelFileRequest: null, workPanelContexts: {}, ...overrides,
  };
  const actions = createWorkPanelSlice({
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    isSessionSelectionPending: () => pending,
  });
  return { actions, get: () => state };
}

const selectedFile = (entry) => {
  const file = summarizeTurnFileChanges(entry).files[0];
  return {
    sessionId: "session-a", turnId: entry.id, selectedPath: file.path,
    snapshotIds: file.entries.map(({ change }) => change.snapshotId),
  };
};

test("summary navigation uses the same compaction boundaries as the mounted transcript", () => {
  const messages = [
    workspaceEdit("before", "snapshot-before", "src/shared.ts"),
    message("checkpoint", "assistant", { content: "Checkpoint" }),
    workspaceEdit("after", "snapshot-after", "src/shared.ts"),
    message("answer", "assistant", { content: "Done" }),
  ];
  const marks = [{ throughMessageId: "checkpoint" }];
  const turn = buildTranscriptEntries(messages, marks).entries.at(-1);
  assert.equal(turn.id, "after");
  const store = reviewStore(messages, { sessionCompactions: { "session-a": marks } });
  store.actions.openTurnFileReview(selectedFile(turn));
  assert.equal(store.get().workPanelOpen, true);
  assert.equal(store.get().activeWorkPanelTabId, "review");
  assert.deepEqual(store.get().workPanelContexts["session-a"].reviewSelection.snapshotIds, ["snapshot-after"]);
});

test("summary navigation resolves a loaded history range instead of only the live tail", () => {
  const live = [workspaceEdit("live", "snapshot-live", "src/shared.ts")];
  const history = [workspaceEdit("history", "snapshot-history", "src/shared.ts")];
  for (const focus of [null, { sessionId: "session-a", messageId: "history", query: "shared", requestId: 1 }]) {
    const view = { messages: history, messageStart: 0, hasMoreBefore: false, hasMoreAfter: true, focus, loading: null };
    const turn = buildTranscriptEntries(transcriptViewMessages(live, view)).entries[0];
    const store = reviewStore(live, { transcriptViews: { "session-a": view } });
    store.actions.openTurnFileReview(selectedFile(turn));
    assert.equal(store.get().workPanelOpen, true);
    assert.ok(store.get().workPanelContexts["session-a"].reviewSelection.snapshotIds.includes("snapshot-history"));
  }
});

test("review navigation rejects stale sessions, pending selection and unrelated snapshots", () => {
  const messages = [workspaceEdit("edit", "snapshot", "src/a.ts")];
  const selection = selectedFile(turnEntries(messages)[0]);
  for (const invalid of [
    { ...selection, sessionId: "session-b" },
    { ...selection, turnId: "missing" },
    { ...selection, snapshotIds: ["foreign"] },
    { ...selection, selectedPath: "src/b.ts" },
  ]) {
    const store = reviewStore(messages);
    store.actions.openTurnFileReview(invalid);
    assert.equal(store.get().workPanelOpen, false);
  }
  const pending = reviewStore(messages, {}, true);
  pending.actions.openTurnFileReview(selection);
  assert.equal(pending.get().workPanelOpen, false);
});

test("explicit file review leaves the subagent detail surface", () => {
  const messages = [workspaceEdit("edit", "snapshot", "src/a.ts")];
  const store = reviewStore(messages, {
    subagentPanel: { sessionId: "session-a", delegationId: "delegate" },
  });
  store.actions.openTurnFileReview(selectedFile(turnEntries(messages)[0]));
  assert.equal(store.get().subagentPanel, null);
  assert.equal(store.get().activeWorkPanelTabId, "review");
});

function rollbackReadingStore(viewMessages) {
  let state = {
    activeSessionId: "session-a", isRunning: false, runningSessions: {},
    retainedSessionIds: ["session-a"], messages: [], sessionHistory: {},
    transcriptViews: { "session-a": {
      messages: viewMessages, messageStart: 100, messageEnd: 101,
      hasMoreBefore: true, hasMoreAfter: true, focus: null, loading: null,
    } },
    showToast: (text) => assert.fail(text),
  };
  const reads = [];
  let reading;
  const access = {
    get: () => state,
    set: (update) => {
      const previous = state;
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
      reading?.reconcile(state, previous);
    },
  };
  reading = createTranscriptReadingRuntime(access, (_id, options) =>
    new Promise((resolve) => reads.push({ options, resolve })),
  );
  const actions = createTranscriptSlice({
    ...access, runtime: { isSessionSelectionPending: () => false },
  });
  return { ...access, reads, actions, reading: reading.actions, view: () => state.transcriptViews["session-a"] };
}

for (const direction of ["before", "after", "target"]) {
  test(`confirmed rollback supersedes pending ${direction} read and permits retry`, async (t) => {
    const record = workspaceEdit("edit", "snapshot", "src/a.ts");
    const store = rollbackReadingStore([record]);
    t.mock.method(api, "workspaceReviewRollback", async () => ({ status: "rolledBack", snapshotId: "snapshot" }));
    const pending = direction === "target"
      ? store.reading.navigateTranscript({ sessionId: "session-a", messageId: "edit", query: "a" })
      : store.reading.loadTranscriptPage("session-a", direction);
    const pendingView = store.view();
    assert.equal(pendingView.loading, direction);
    await store.actions.rollbackWorkspaceChange("edit", "snapshot");
    const rolledBack = store.view().messages[0];
    assert.equal(reviewChangesFromMessage(rolledBack)[0].state, "rolledBack");
    assert.notEqual(store.view(), pendingView);
    assert.equal(store.view().loading, null);

    const retry = store.reading.loadTranscriptPage("session-a", "before");
    const retryView = store.view();
    assert.equal(store.reads.length, 2, "cleared loading must allow another page request");
    store.reads[0].resolve({ session: { messages: [record], messageStart: 0, messageEnd: 101 } });
    await pending;
    assert.equal(store.view(), retryView, "superseded read must not clobber the newer request");
    assert.equal(reviewChangesFromMessage(store.view().messages[0])[0].state, "rolledBack");
    assert.equal(store.view().loading, "before");

    store.reads[1].resolve({ session: {
      messages: [message("older", "user"), rolledBack], messageStart: 0,
      messageEnd: 101, hasMoreBefore: false,
    } });
    await retry;
    assert.equal(store.view().loading, null);
    assert.equal(store.view().hasMoreBefore, false);
    assert.deepEqual(store.view().messages.map((item) => item.id), ["older", "edit"]);
    assert.equal(reviewChangesFromMessage(store.view().messages[1])[0].state, "rolledBack");
  });
}

test("rollback outside the reading range preserves its pending read identity", async (t) => {
  const store = rollbackReadingStore([message("history", "user")]);
  t.mock.method(api, "workspaceReviewRollback", async () => ({ status: "rolledBack", snapshotId: "snapshot" }));
  const pending = store.reading.loadTranscriptPage("session-a", "before");
  const pendingView = store.view();
  await store.actions.rollbackWorkspaceChange("edit", "snapshot");
  assert.equal(store.view(), pendingView);
  store.reads[0].resolve({ session: { messages: [message("older", "user")], messageStart: 0, hasMoreBefore: false } });
  await pending;
  assert.equal(store.view().loading, null);
  assert.equal(store.view().messages[0].id, "older");
});
