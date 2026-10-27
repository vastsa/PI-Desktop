#!/usr/bin/env node
/** Real Host + main persistence/outbox + renderer projections, with synthetic
 * messages in an isolated profile. No provider or full Electron UI is used. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../apps/desktop/electron/main/runtime/event-persistence.ts");
const { createSessionCoordination } = await import("../apps/desktop/electron/main/runtime/session-coordination.ts");
const { PersistenceOutbox } = await import("../apps/desktop/electron/main/persistence-outbox.ts");
const { createSessionRuntime } = await import("../apps/desktop/src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../apps/desktop/src/stores/slices/events-slice.ts");
const { createSessionSlice } = await import("../apps/desktop/src/stores/slices/session-slice.ts");
const { api } = await import("../apps/desktop/src/lib/api.ts");

const temp = await mkdtemp(join(tmpdir(), "pi-regenerate-root-"));
const dataDir = join(temp, "data");
const workspace = join(temp, "workspace");
const host = new Host(resolveHostBinary(), dataDir);
const totalMessages = 3484;
const rootPosition = 655;
const pageSize = 100;
const warnings = [];
const message = (id, role, content, index) => ({
  id, role, content, status: "complete",
  createdAt: new Date(Date.UTC(2026, 9, 20) + index * 1_000).toISOString(),
});

function renderer(sessionId, page, active) {
  const otherMessages = [message("other-user", "user", "Another session", 0)];
  let state = {
    activeSessionId: active ? sessionId : "another-session",
    messages: active ? page : otherMessages,
    retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: page },
    runningSessions: {}, sessionHistory: {},
  };
  let runtime;
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript(sessionId, page);
  Object.assign(state, createEventsSlice({ ...access, runtime }));
  return { ...access, runtime, otherMessages };
}

async function finishBranch(sessionId, page, active, unloaded = false) {
  const ui = renderer(sessionId, page, active);
  if (unloaded) {
    assert.equal(active, false);
    ui.runtime.sessionTranscriptCache.delete(sessionId);
    ui.set({ retainedTranscripts: {} });
  }
  const { turnId } = await host.call("session.beginTurn", { sessionId });
  const activeTurns = new Map([[sessionId, turnId]]);
  const coordination = createSessionCoordination({
    activeTurns, getMainWindow: () => null, getViewingSessionId: () => null,
  });
  coordination.recordTurnStart(sessionId, turnId);
  const emitted = [];
  const persistence = createEventPersistence({
    runtimeState: { host }, activeTurns,
    steeringReplies: new Set(), completionNoticeTurns: new Set(),
    activeToolCalls: new Map(), activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: { observe() {}, flush: async () => {}, settleIf() {} },
    persistenceOutbox: new PersistenceOutbox(dataDir, (...args) => warnings.push(args)),
    transcriptRewrite: coordination, addActiveTurnUsage() {},
    logger: { app: (...args) => warnings.push(args) },
    finishTurn: async (_id, status) => {
      await host.call("session.endTurn", { turnId, status });
      activeTurns.delete(sessionId);
    },
    isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    finishApprovedExecution: async () => {},
    emitAgentEvent: (envelope) => {
      emitted.push(envelope);
      ui.get().handleAgentEvent(envelope);
    },
  });
  persistence.persistAgentEvent({ sessionId, turnId, ts: Date.now(),
    event: { type: "agent_end", messageIds: [page.at(-1).id] } });
  await persistence.flush();
  assert.deepEqual(warnings, []);
  assert.equal(emitted.length, 1, "the real host returned the historical root");
  if (unloaded) {
    assert.equal(ui.runtime.sessionTranscriptCache.has(sessionId), false);
    assert.equal(ui.runtime.liveSessionTranscripts.has(sessionId), false);
    assert.deepEqual(ui.get().retainedTranscripts, {});
    assert.equal(ui.get().messages, ui.otherMessages);
    const originalGetSession = api.getSession;
    let reads = 0;
    api.getSession = async (id, options) => {
      reads++;
      return host.call("session.get", { id, ...options });
    };
    try {
      const sessions = createSessionSlice({ get: ui.get, set: ui.set, runtime: ui.runtime });
      await sessions.prefetchSession(sessionId);
      assert.equal(reads, 1);
      assert.deepEqual(ui.runtime.sessionTranscriptCache.get(sessionId).map((row) => row.id), page.map((row) => row.id));
    } finally {
      api.getSession = originalGetSession;
    }
    return { ui, root: emitted[0].event.message };
  }
  for (const rows of [ui.runtime.sessionTranscriptCache.get(sessionId), ui.get().retainedTranscripts[sessionId]]) {
    assert.deepEqual(rows.map((row) => row.id), page.map((row) => row.id));
    assert.equal(rows.at(-1).id, page.at(-1).id);
  }
  if (active) assert.deepEqual(ui.get().messages.map((row) => row.id), page.map((row) => row.id));
  else assert.equal(ui.get().messages, ui.otherMessages);
  return { ui, root: emitted[0].event.message };
}

try {
  await mkdir(workspace);
  await host.start();
  const { session } = await host.call("session.create", {
    title: "Regenerate root projection regression", mode: "agent", projectPath: workspace,
  });
  const sessionId = session.id;
  const original = Array.from({ length: totalMessages }, (_, index) =>
    message(`old-${index}`, index === rootPosition || index % 2 === 0 ? "user" : "assistant", `History ${index}`, index));
  await host.call("session.replaceMessages", { sessionId, messages: original });
  const truncated = await host.call("session.truncateFrom", {
    sessionId, fromMessageId: original[rootPosition].id,
  });
  assert.equal(truncated.discardedCount, totalMessages - rootPosition);
  const family = truncated.revision.rootUserId;
  const live = original.slice(0, rootPosition);
  live.push({ ...original[rootPosition], id: "rewritten-root",
    revisionRootId: family, revisionCount: truncated.revision.revisionCount,
    activeRevision: truncated.revision.activeRevision });
  for (let index = rootPosition + 1; index < totalMessages; index++) {
    live.push(message(`live-${index}`, index % 2 === 0 ? "user" : "assistant", `Continued history ${index}`, index));
  }
  await host.call("session.replaceMessages", { sessionId, messages: live });

  const latest = async () => (await host.call("session.get", { id: sessionId, messageLimit: pageSize })).session;
  const firstPage = await latest();
  assert.equal(firstPage.messageStart, totalMessages - pageSize);
  assert.equal(firstPage.messages.length, pageSize);
  assert.equal(firstPage.messages.some((row) => row.id === "rewritten-root"), false);
  for (const active of [true, false]) {
    const { root } = await finishBranch(sessionId, firstPage.messages, active);
    assert.equal(root.id, "rewritten-root");
    assert.equal(root.revisionRootId, family);
  }
  await finishBranch(sessionId, firstPage.messages, false, true);

  // The exact arithmetic in #1870 is the normal live suffix length, not a
  // lookup that needs the old family key to remain in the messages table.
  const { revisions } = await host.call("session.listRevisions", { sessionId, rootUserId: family });
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].messageCount, totalMessages - rootPosition);
  assert.equal(totalMessages - revisions[1].messageCount, rootPosition);
  const full = (await host.call("session.get", { id: sessionId })).session.messages;
  assert.equal(full.some((row) => row.id === family), false);
  for (const active of [true, false]) {
    const loaded = await finishBranch(sessionId, full, active);
    assert.deepEqual(loaded.ui.runtime.sessionTranscriptCache.get(sessionId)[rootPosition], loaded.root);
    assert.deepEqual(loaded.ui.get().retainedTranscripts[sessionId][rootPosition], loaded.root);
  }

  for (let index = 0; index < 3; index++) {
    await host.call("session.appendMessage", { sessionId, message: message(`follow-user-${index}`, "user", "Continue", totalMessages + index * 2) });
    await host.call("session.appendMessage", { sessionId, message: message(`follow-answer-${index}`, "assistant", "Latest reply", totalMessages + index * 2 + 1) });
    await finishBranch(sessionId, (await latest()).messages, index % 2 === 0);
  }
  const expectedIds = [...live.map((row) => row.id), ...Array.from({ length: 3 }, (_, index) => [`follow-user-${index}`, `follow-answer-${index}`]).flat()];
  await host.restart();
  for (const revisionIndex of [1, 2]) {
    const { messages } = await host.call("session.activateRevision", {
      sessionId, rootUserId: family, revisionIndex, prefix: [],
    });
    assert.deepEqual(messages.map((row) => row.id), revisionIndex === 1 ? original.map((row) => row.id) : expectedIds);
  }
  const raw = await readFile(join(dataDir, "sessions", `${sessionId}.jsonl`), "utf8");
  const records = raw.trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.type === "message");
  assert.deepEqual(records.map((row) => row.id), expectedIds);
  console.log(JSON.stringify({ scenario: "E2E-118 / #1870", totalMessages,
    rootPosition, branchMessageCount: revisions[1].messageCount, pageSize,
    projectionCases: 5, unloadedSessionPrefetch: "passed", followUpTurns: 3, restartAndRevisionRoundTrip: "passed",
    finalMessages: records.length, warnings: warnings.length }));
} finally {
  await host.stop();
  await rm(temp, { recursive: true, force: true });
}
