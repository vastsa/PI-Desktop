import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { getSessionMessageSnapshot } = await import("../src/lib/session-transcript-updates.ts");
const { getTranscriptProjection } = await import("../src/lib/transcript-projection.ts");

const message = (id, overrides = {}) => ({
  id, role: "assistant", content: id, createdAt: "2026-09-30T00:00:00Z", ...overrides,
});
const envelope = (sessionId, id, deltaText) => ({
  sessionId, ts: 1,
  event: { type: "message_update", stream: "delta", message: message(id, { content: "", status: "streaming" }), deltaText },
});

function harness(messages, background = []) {
  let runtime;
  let writes = 0;
  let state = {
    activeSessionId: "active", messages,
    retainedSessionIds: ["active", "background"],
    retainedTranscripts: { active: messages, background },
    runningSessions: { active: true, background: true },
    sessionHistory: {},
  };
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next === state) return;
      writes++;
      state = { ...state, ...next };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript("active", messages);
  runtime.cacheSessionTranscript("background", background);
  Object.assign(state, createEventsSlice({ ...access, runtime }));
  return { ...access, runtime, writes: () => writes };
}

function withFrames(run) {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => { pending.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = (handle) => pending.delete(handle);
  try {
    run(() => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(0));
    });
    assert.equal(pending.size, 0, "each synthetic frame is drained");
  } finally {
    if (originalRequest) globalThis.requestAnimationFrame = originalRequest;
    else delete globalThis.requestAnimationFrame;
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
    else delete globalThis.cancelAnimationFrame;
  }
}

test("active frame updates and cache publication do not reread historical ids", () => withFrames((flush) => {
  let historicalReads = 0;
  const history = Array.from({ length: 10_000 }, (_, index) => ({
    ...message(`old-${index}`),
    get id() { historicalReads++; return `old-${index}`; },
  }));
  history.splice(2, 0, message("live", { content: "", status: "streaming" }));
  const h = harness(history);
  const initial = getSessionMessageSnapshot(history);
  historicalReads = 0;
  for (let index = 0; index < 10; index++) {
    h.get().handleAgentEvent(envelope("active", "live", "a"));
    h.get().handleAgentEvent(envelope("active", "live", "b"));
    flush();
  }
  assert.equal(historicalReads, 0);
  assert.equal(h.get().messages[2].content, "ab".repeat(10));
  assert.equal(h.get().messages.length, history.length);
  assert.equal(h.runtime.sessionTranscriptCache.get("active"), h.get().messages);
  assert.equal(h.get().retainedTranscripts.active, h.get().messages);
  const latest = getSessionMessageSnapshot(h.get().messages);
  assert.equal(latest.owner, initial.owner);
  assert.equal(latest.positions, initial.positions);
  assert.equal(latest.blocks[1], initial.blocks[1]);
  assert.equal(history[2].content, "");
}));

test("background deltas update only their cache and leave active and retained arrays unchanged", () => withFrames((flush) => {
  let historicalReads = 0;
  const background = Array.from({ length: 200 }, (_, index) => ({
    ...message(`background-${index}`),
    get id() { historicalReads++; return `background-${index}`; },
  }));
  background.push(message("live", { content: "", status: "streaming" }));
  const active = [message("live", { content: "other session" })];
  const h = harness(active, background);
  const retained = h.get().retainedTranscripts;
  historicalReads = 0;
  h.get().handleAgentEvent(envelope("background", "live", "delta"));
  flush();
  assert.equal(historicalReads, 0);
  assert.equal(h.writes(), 0);
  assert.equal(h.get().messages, active);
  assert.equal(h.get().retainedTranscripts, retained);
  assert.equal(h.get().retainedTranscripts.background, background);
  assert.equal(background.at(-1).content, "");
  const cached = h.runtime.sessionTranscriptCache.get("background");
  assert.equal(cached.at(-1).content, "delta");
  assert.equal(getSessionMessageSnapshot(cached).owner, getSessionMessageSnapshot(background).owner);
}));

test("active and background duplicate inputs apply deltas to the last value at the first position", () => withFrames((flush) => {
  const duplicates = () => [message("live", { content: "old" }), message("middle"), message("live", { content: "latest" })];
  const h = harness(duplicates(), duplicates());
  for (const sessionId of ["active", "background"]) h.get().handleAgentEvent(envelope(sessionId, "live", "+delta"));
  flush();
  for (const rows of [h.get().messages, h.runtime.sessionTranscriptCache.get("background")]) {
    assert.deepEqual(rows.map((row) => row.id), ["live", "middle"]);
    assert.equal(rows[0].content, "latest+delta");
    assert.equal(getSessionMessageSnapshot(rows).unique, true);
  }
}));

test("a delta before message_start appends once and terminal events flush the exact live row", () => withFrames((flush) => {
  const h = harness([message("historical")]);
  h.get().handleAgentEvent(envelope("active", "missing", "partial"));
  flush();
  const beforeTerminal = h.get().messages;
  h.get().handleAgentEvent({ sessionId: "active", ts: 2, event: { type: "message_start", message: message("missing", { content: "" }) } });
  assert.equal(h.get().messages, beforeTerminal, "late start does not reset a partial row");
  h.get().handleAgentEvent(envelope("active", "missing", "+queued"));
  h.get().handleAgentEvent({ sessionId: "active", ts: 3, event: { type: "message_end", message: message("missing", { content: "final", status: "complete" }) } });
  assert.deepEqual(h.get().messages.map((row) => row.id), ["historical", "missing"]);
  assert.equal(h.get().messages.at(-1).content, "final");
  assert.equal(beforeTerminal.at(-1).content, "partial");
}));

const partialTool = (sessionId, toolCallId, partialResult) => ({
  sessionId, ts: 1, event: { type: "tool_update", toolCallId, partialResult },
});

test("warm foreground tool partials preserve tracked projection without historical identity or content reads", () => withFrames((flush) => {
  const reads = { id: 0, toolCallId: 0, content: 0 };
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...message(`old-${index}`, { role: index % 2 ? "assistant" : "user" }),
    get id() { reads.id++; return `old-${index}`; },
    get toolCallId() { reads.toolCallId++; return undefined; },
    get content() { reads.content++; return `Historical ${index}`; },
  }));
  rows.push(message("noncanonical-tool-row", {
    role: "tool", toolCallId: "live-call", toolName: "Bash", toolStatus: "running", content: "seed",
  }));
  const h = harness(rows);
  const source = getSessionMessageSnapshot(rows);
  const projection = getTranscriptProjection(rows);
  Object.assign(reads, { id: 0, toolCallId: 0, content: 0 });
  let projected;
  for (let index = 0; index < 10; index++) {
    h.get().handleAgentEvent(partialTool("active", "live-call", `partial ${index}`));
    flush();
    projected = getTranscriptProjection(h.get().messages);
  }
  assert.deepEqual(reads, { id: 0, toolCallId: 0, content: 0 });
  assert.equal(h.get().messages.at(-1).content, "partial 9");
  assert.equal(projected.visible.at(-1), h.get().messages.at(-1));
  assert.equal(projected.history, projection.history);
  assert.equal(getSessionMessageSnapshot(h.get().messages).owner, source.owner);
  assert.equal(getSessionMessageSnapshot(h.get().messages).positions, source.positions);
  assert.equal(getSessionMessageSnapshot(h.get().messages).blocks[0], source.blocks[0]);
  assert.equal(rows.at(-1).content, "seed");
}));

test("foreground tool partials replace all running call matches, including duplicate and non-tool rows", () => withFrames((flush) => {
  const rows = [
    message("duplicate", { role: "tool", toolCallId: "call", toolStatus: "running", content: "first" }),
    message("complete", { role: "tool", toolCallId: "call", toolStatus: "success", content: "done" }),
    message("duplicate", { role: "tool", toolCallId: "call", toolStatus: "running", content: "last" }),
    message("unusual", { role: "assistant", toolCallId: "call", toolStatus: "running" }),
    message("other", { role: "tool", toolCallId: "different", toolStatus: "running" }),
  ];
  const h = harness(rows);
  h.get().handleAgentEvent(partialTool("active", "call", { stdout: "partial" }));
  flush();
  assert.equal(h.get().messages.length, rows.length, "the foreground path does not dedupe physical rows");
  for (const index of [0, 2, 3]) {
    assert.notEqual(h.get().messages[index], rows[index]);
    assert.deepEqual(h.get().messages[index].toolResult, { stdout: "partial" });
    assert.match(h.get().messages[index].content, /partial/);
  }
  for (const index of [1, 4]) assert.equal(h.get().messages[index], rows[index]);
  const unchanged = h.get().messages;
  h.get().handleAgentEvent(partialTool("active", "missing", "ignored"));
  h.get().handleAgentEvent(partialTool("active", "call", undefined));
  flush();
  assert.equal(h.get().messages, unchanged);
}));

test("background tool partials stay cache-only and update the first running match without historical scans", () => withFrames((flush) => {
  let reads = 0;
  const background = Array.from({ length: 200 }, (_, index) => ({
    ...message(`old-${index}`),
    get id() { reads++; return `old-${index}`; },
    get toolCallId() { reads++; return undefined; },
    get content() { reads++; return "history"; },
  }));
  background.push(
    message("complete", { toolCallId: "call", toolStatus: "success" }),
    message("first", { toolCallId: "call", toolStatus: "running" }),
    message("second", { toolCallId: "call", toolStatus: "running" }),
  );
  const h = harness([message("active")], background);
  const retained = h.get().retainedTranscripts;
  reads = 0;
  h.get().handleAgentEvent(partialTool("background", "call", "partial"));
  flush();
  const updated = h.runtime.sessionTranscriptCache.get("background");
  assert.equal(reads, 0);
  assert.equal(updated.at(-2).content, "partial");
  assert.equal(updated.at(-1), background.at(-1));
  assert.equal(updated.at(-3), background.at(-3));
  assert.equal(h.get().retainedTranscripts, retained);
  assert.equal(h.writes(), 0);
}));
