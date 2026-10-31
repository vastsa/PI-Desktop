import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { register } from "node:module";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const transcript = await import("../src/lib/session-transcript.ts");
const safety = await import("../src/lib/remote-session-safety.ts");
const permissions = await import("../src/lib/pending-permissions.ts");
const smartStop = await import("../src/lib/composer-smart-stop.ts");
function load(relative, imports, globals = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}
const row = (id, role) => ({ id, role, content: id, status: "complete" });
const previous = [row("u1", "user"), row("t1", "tool"), row("a1", "assistant"), row("u2", "user"), row("a2", "assistant")];
function harness(overrides = {}) {
  let state = { activeSessionId: "s", isRunning: false, messages: [...previous], sessions: [{ id: "s", source: "desktop" }], sessionHistory: {}, retainedTranscripts: {}, pendingPermissions: {}, runningSessions: {}, ...overrides.state };
  const calls = [];
  const api = {
    deleteSessionMessage: async (input) => { calls.push(["delete", input]); return { ok: true, deleted: true, deletedCount: 3 }; },
    activateSessionRevision: async (input) => { calls.push(["activate", input]); return { messages: previous }; },
    retractPendingSessionPrompt: async (input) => { calls.push(["retract", input]); return { ok: true, retracted: true, removedCount: 1 }; },
    abort: async () => {}, ...overrides.api,
  };
  const runtime = { loadFullSessionMessages: async () => previous, cacheSessionTranscript() {}, sessionTranscriptCache: new Map(), submittedComposerDrafts: new Map(), ...overrides.runtime };
  const { createTranscriptSlice } = load("../src/stores/slices/transcript-slice.ts", {
    i18next: { default: { t: (key) => key } }, "../../lib/api": { api },
    "../../lib/remote-session-safety": safety, "@pi-desktop/shared": {},
    "../../lib/composer-smart-stop": smartStop, "../../lib/pending-permissions": permissions,
    "../../lib/session-transcript": transcript, "../../lib/workspace-review": {},
    "../../lib/context-usage": { settleStoppedAssistantMetrics: (message) => message }, "../runtime/transcript-action": {},
  });
  const actions = createTranscriptSlice({ get: () => state, set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; }, runtime, flushPendingSessionConfiguration: async () => {} });
  return { actions, calls, runtime, state: () => state, update: (next) => { state = { ...state, ...next }; } };
}
test("delete uses only the durable id and removes the entire user turn", async () => {
  const h = harness(); await h.actions.deleteMessage("u1");
  assert.deepEqual(h.calls, [["delete", { sessionId: "s", messageId: "u1" }]]);
  assert.deepEqual(h.state().messages.map((m) => m.id), ["u2", "a2"]);
});
test("failed delete rolls back and exposes the durable error", async () => {
  const h = harness({ api: { deleteSessionMessage: async () => { throw new Error("delete failed"); } } });
  await h.actions.deleteMessage("u1"); assert.deepEqual(h.state().messages, previous); assert.equal(h.state().error, "delete failed");
});
test("activation requests canonical prefix with no historical messages", async () => {
  const h = harness(); await h.actions.activateMessageRevision("u2", 1);
  assert.deepEqual(h.calls, [["activate", { sessionId: "s", rootUserId: "u2", revisionIndex: 1, requireCanonicalPrefix: true }]]);
});
for (const outcome of ["success", "exception", "reply_started"]) {
  test(`smart stop preserves durable state and drafts on ${outcome}`, async () => {
    const messages = previous.slice(0, 4);
    const submitted = { messageCountBeforeSend: 3, draft: { text: "second", fileReferences: [] } };
    const h = harness({ state: { messages, isRunning: true }, runtime: { loadFullSessionMessages: async () => messages, submittedComposerDrafts: new Map([["s", submitted]]) }, api: outcome === "success" ? {} : { retractPendingSessionPrompt: async () => { if (outcome === "exception") throw new Error("retract failed"); return { retracted: false, reason: outcome }; } } });
    await h.actions.abort();
    if (outcome === "success") {
      assert.deepEqual(h.calls, [["retract", { sessionId: "s", userMessageId: "u2" }]]);
      assert.equal(h.state().composerPrefill.text, "second"); assert.equal(await submitted.abortResolution, true);
      assert.deepEqual(h.state().messages.map((m) => m.id), ["u1", "t1", "a1"]);
    } else {
      assert.equal(h.state().messages.at(-1).id, "u2"); assert.equal(h.state().composerPrefill, undefined);
      assert.equal(h.runtime.submittedComposerDrafts.get("s"), submitted); assert.equal(await submitted.abortResolution, false); assert.ok(h.state().error);
    }
  });
}
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} }, "node:fs": fs, "node:path": path, "@pi-desktop/shared": { ErrorCodes, IPC }, "../importers": {}, "../services/session-collaboration": {}, "../bootstrap/remote-hosts.js": {}, "../services/session-search": {},
});
function ipcHarness(pending = false, result = { ok: true }) {
  const handlers = new Map(); const events = [];
  const host = { call: async (method, input) => { events.push([method, input]); return typeof result === "function" ? result(method) : result; } };
  registerSessionIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host,
    getSidecar: () => ({ clearProjectInstructionRoot() {}, clearVendorAuthBindings() {}, call: async () => { events.push(["dispose"]); } }), activeTurns: new Map(),
    persistenceOutbox: { prepareSessionMutation: async (id) => { events.push(["strict-drain", id]); if (pending) throw new Error("pending write"); }, prepareSessionReplacement: async () => { events.push(["replacement-drain"]); } },
    acquireSessionOperation: async () => { events.push(["lock"]); return () => events.push(["release"]); },
    beginTranscriptRewrite: () => { events.push(["fence"]); return { commit: () => events.push(["commit"]), rollback: () => events.push(["rollback"]) }; }, sessionProjects: new Map(), logger: {}, plugins: {},
  });
  return { events, invoke: (channel, input) => { assert.equal(typeof handlers.get(IPC.invoke[channel]), "function"); return handlers.get(IPC.invoke[channel])(input); } };
}
for (const [channel, method, input] of [
  ["sessionDeleteMessage", "session.deleteMessage", { sessionId: "s", messageId: "u1" }],
  ["sessionRetractPendingPrompt", "session.retractPendingPrompt", { sessionId: "s", userMessageId: "u2", turnId: "turn" }],
  ["sessionActivateRevision", "session.activateRevision", { sessionId: "s", rootUserId: "u1", revisionIndex: 2, requireCanonicalPrefix: true }],
]) {
  test(`${channel} strictly drains before host mutation under rewrite fence`, async () => {
    const h = ipcHarness(); assert.ok(IPC_WHITELIST.has(IPC.invoke[channel])); await h.invoke(channel, input);
    assert.deepEqual(h.events, [["lock"], ["fence"], ["strict-drain", "s"], ["dispose"], [method, input], ["commit"], ["release"]]);
  });
  test(`${channel} refuses mutation on strict drain failure`, async () => {
    const h = ipcHarness(true); await assert.rejects(h.invoke(channel, input), /pending write/);
    assert.deepEqual(h.events, [["lock"], ["fence"], ["strict-drain", "s"], ["rollback"], ["release"]]);
  });
}
test("legacy replace and explicit prefix activation retain old wire shapes", async () => {
  const h = ipcHarness(); await h.invoke("sessionReplaceMessages", { sessionId: "s", messages: previous });
  await h.invoke("sessionActivateRevision", { sessionId: "s", rootUserId: "u2", revisionIndex: 1, prefix: previous });
  assert.deepEqual(h.events.find(([kind]) => kind === "session.replaceMessages"), ["session.replaceMessages", { sessionId: "s", messages: previous }]);
  assert.deepEqual(h.events.find(([kind]) => kind === "session.activateRevision"), ["session.activateRevision", { sessionId: "s", rootUserId: "u2", revisionIndex: 1, prefix: previous }]);
});

test("failed optimistic delete preserves unrelated callbacks received while awaiting the host", async () => {
  let h;
  const late = row("a3", "assistant");
  h = harness({ api: { deleteSessionMessage: async () => { h.update({ messages: [...h.state().messages, late] }); throw new Error("delete failed"); } } });
  await h.actions.deleteMessage("u1");
  assert.deepEqual(h.state().messages.map((message) => message.id), [...previous.map((message) => message.id), "a3"]);
});

test("activation does not overwrite a prompt admitted while its response is pending", async () => {
  let h;
  h = harness({ api: { activateSessionRevision: async () => {
    h.update({ isRunning: true, messages: [...h.state().messages, row("u3", "user")] });
    return { messages: previous };
  } } });
  await h.actions.activateMessageRevision("u2", 1);
  assert.equal(h.state().messages.at(-1).id, "u3");
});

test("smart stop refuses a different pending user projected during its reload", async () => {
  const messages = previous.slice(0, 4);
  const submitted = { messageCountBeforeSend: 3, draft: { text: "second", fileReferences: [] } };
  let h;
  h = harness({ state: { messages, isRunning: true }, runtime: {
    loadFullSessionMessages: async () => { const next = [...messages, row("u3", "user")]; h.update({ messages: next }); return next; },
    submittedComposerDrafts: new Map([["s", submitted]]),
  } });
  await h.actions.abort();
  assert.deepEqual(h.calls, []);
  assert.equal(h.state().messages.at(-1).id, "u3");
  assert.equal(h.state().isRunning, true, "the old abort cannot stop the newer user turn");
  assert.equal(h.state().composerPrefill, undefined);
  assert.equal(await submitted.abortResolution, false);
});

test("refused conditional retraction rolls back its fence so late old-turn callbacks survive", async () => {
  const h = ipcHarness(false, { ok: true, retracted: false, reason: "reply_started" });
  const result = await h.invoke("sessionRetractPendingPrompt", { sessionId: "s", userMessageId: "u2" });
  assert.equal(result.retracted, false);
  assert.deepEqual(h.events.slice(-2), [["rollback"], ["release"]]);
});

test("new ID mutations preserve the existing remote read-only capability boundary", () => {
  const { guardRemoteInvocation } = load("../src/lib/remote-ipc-safety.ts", {
    "@pi-desktop/shared": { IPC }, i18next: { default: { t: () => "Remote history is read-only" } },
  });
  for (const channel of [IPC.invoke.sessionDeleteMessage, IPC.invoke.sessionRetractPendingPrompt]) {
    assert.throws(() => guardRemoteInvocation(channel, { sessionId: "remote:host:session", messageId: "m" }), { code: "CAPABILITY_UNAVAILABLE" });
    assert.doesNotThrow(() => guardRemoteInvocation(channel, { sessionId: "local-session", messageId: "m" }));
  }
});

test("the real store/API/preload/IPC path uploads bounded ids with more than 64 MiB retained history", async () => {
  const huge = [...previous];
  huge[1] = { ...huge[1], content: "A".repeat(65 * 1024 * 1024) };
  const wire = [];
  const ipc = ipcHarness(false, (method) => method === "session.activateRevision"
    ? { messages: huge }
    : { ok: true, deleted: true, deletedCount: 2, retracted: true, removedCount: 1 });
  let bridge;
  const shared = { ErrorCodes, IPC, IPC_WHITELIST };
  load("../electron/preload/index.ts", {
    electron: { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, webUtils: {}, ipcRenderer: { invoke: async (channel, input) => {
      wire.push(JSON.stringify({ channel, input }));
      const key = Object.keys(IPC.invoke).find((key) => IPC.invoke[key] === channel);
      assert.ok(["sessionDeleteMessage", "sessionRetractPendingPrompt", "sessionActivateRevision"].includes(key));
      return { ok: true, data: await ipc.invoke(key, input) };
    } } }, "@pi-desktop/shared": shared, "@pi-desktop/shared/protocol": shared,
  });
  const { api } = load("../src/lib/api.ts", {
    "@pi-desktop/shared": shared, "./plan-history": {}, "./remote-session-safety": safety,
    "./remote-ipc-safety": { guardRemoteInvocation() {} },
  }, { window: { piDesktop: bridge } });
  const h = harness({ state: { messages: huge }, runtime: { loadFullSessionMessages: async () => huge }, api });
  await h.actions.deleteMessage("u2");
  assert.equal(wire.length, 1);
  assert.ok(Buffer.byteLength(wire[0]) < 256);
  assert.equal(h.state().messages[1].content, huge[1].content);
  assert.deepEqual(h.state().messages.map((message) => message.id), ["u1", "t1", "a1"]);
  h.update({ messages: huge });
  await h.actions.activateMessageRevision("u2", 1);
  assert.equal(h.state().messages[1].content, huge[1].content);
  const submitted = { messageCountBeforeSend: 3, draft: { text: "second", fileReferences: [] } };
  const stopMessages = huge.slice(0, 4);
  // Agent abort is outside the transcript mutation channel under test.
  api.abort = async () => {};
  const stop = harness({ state: { messages: stopMessages, isRunning: true }, api, runtime: {
    loadFullSessionMessages: async () => stopMessages,
    submittedComposerDrafts: new Map([["s", submitted]]),
  } });
  await stop.actions.abort();
  assert.equal(await submitted.abortResolution, true);
  assert.equal(stop.state().messages[1].content, huge[1].content);
  assert.equal(wire.length, 3);
  assert.ok(wire.every((frame) => Buffer.byteLength(frame) < 256));
});

test("a completed smart stop updates its own cache and restores its session draft after a session switch", async () => {
  const messages = previous.slice(0, 4);
  const submitted = { messageCountBeforeSend: 3, draft: { text: "second", fileReferences: [] } };
  const cached = new Map([["s", messages]]);
  let h;
  h = harness({ state: { messages, isRunning: true }, runtime: {
    loadFullSessionMessages: async () => messages,
    submittedComposerDrafts: new Map([["s", submitted]]), sessionTranscriptCache: cached,
    cacheSessionTranscript: (id, rows) => cached.set(id, rows),
  }, api: { retractPendingSessionPrompt: async () => {
    h.update({ activeSessionId: "other", messages: [row("other-user", "user")] });
    return { retracted: true, removedCount: 1 };
  } } });
  await h.actions.abort();
  assert.deepEqual(cached.get("s").map((message) => message.id), ["u1", "t1", "a1"]);
  assert.equal(h.state().messages.at(-1).id, "other-user");
  assert.equal(h.state().composerPrefill?.sessionId, "s");
  assert.equal(h.state().composerPrefill?.text, "second");
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

for (const firstFails of [false, true]) {
  test(`consecutive deletes serialize their reads and release the session queue after ${firstFails ? "failure" : "success"}`, async () => {
    const firstStarted = deferred();
    const firstResponse = deferred();
    let durable = [...previous];
    let loads = 0;
    const calls = [];
    let h;
    h = harness({ runtime: { loadFullSessionMessages: async () => { loads++; return [...durable]; } }, api: {
      deleteSessionMessage: async (input) => {
        calls.push(input);
        if (input.messageId === "u1") {
          firstStarted.resolve();
          await firstResponse.promise;
          if (firstFails) throw new Error("first delete failed");
          durable = durable.filter((message) => ["u2", "a2", "u3", "late"].includes(message.id));
        } else {
          durable = durable.filter((message) => !["u2", "a2"].includes(message.id));
        }
        return { ok: true, deleted: true };
      },
    } });
    const first = h.actions.deleteMessage("u1");
    await firstStarted.promise;
    const second = h.actions.deleteMessage("u2");
    // A callback from the surviving turn arrives while the first request waits.
    const late = [row("u3", "user"), row("late", "assistant")];
    durable = [...durable, ...late];
    h.update({ messages: [...h.state().messages, ...late] });
    assert.equal(loads, 1, "the second delete cannot reload pre-mutation durable history");
    firstResponse.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(calls, [{ sessionId: "s", messageId: "u1" }, { sessionId: "s", messageId: "u2" }]);
    assert.deepEqual(h.state().messages.map((message) => message.id), firstFails ? ["u1", "t1", "a1", "u3", "late"] : ["u3", "late"]);
    assert.deepEqual(h.state().messages, durable);
  });
}

test("a queued delete cannot switch to a different active session and releases its queue", async () => {
  const firstStarted = deferred();
  const firstResponse = deferred();
  let durable = [...previous];
  const calls = [];
  let h;
  h = harness({ runtime: { loadFullSessionMessages: async () => [...durable] }, api: {
    deleteSessionMessage: async (input) => {
      calls.push(input);
      if (input.messageId === "u1") { firstStarted.resolve(); await firstResponse.promise; }
      durable = durable.filter((message) => input.messageId === "u1" ? ["u2", "a2"].includes(message.id) : !["u2", "a2"].includes(message.id));
      return { ok: true, deleted: true };
    },
  } });
  const first = h.actions.deleteMessage("u1");
  await firstStarted.promise;
  const queued = h.actions.deleteMessage("u2");
  h.update({ activeSessionId: "other", messages: [row("other", "user")] });
  firstResponse.resolve();
  await Promise.all([first, queued]);
  assert.deepEqual(calls, [{ sessionId: "s", messageId: "u1" }]);
  assert.equal(h.state().messages[0].id, "other");
  h.update({ activeSessionId: "s", messages: [...durable] });
  await h.actions.deleteMessage("u2");
  assert.deepEqual(calls.at(-1), { sessionId: "s", messageId: "u2" });
  assert.deepEqual(h.state().messages, []);
});

test("a missing durable delete target preserves its user-turn projection and cache", async () => {
  const durable = previous.filter((message) => message.id !== "u1");
  const cached = new Map();
  const h = harness({ runtime: {
    loadFullSessionMessages: async () => durable,
    sessionTranscriptCache: cached,
    cacheSessionTranscript: (id, messages) => cached.set(id, messages),
  }, api: { deleteSessionMessage: async () => ({ ok: true, deleted: false, deletedCount: 0 }) } });
  await h.actions.deleteMessage("u1");
  assert.deepEqual(h.state().messages, previous, "a Host no-op cannot hide durable replies after a live-only prompt");
  assert.deepEqual(cached.get("s"), previous);
  assert.equal(h.state().error, null, "a missing target is an acknowledged no-op, not an RPC failure");
});

for (const outcome of ["no-op", "failure"]) {
  for (const switchSession of [false, true]) {
    test(`${outcome} delete preserves its own projection with a new turn, late terminal update, and ${switchSession ? "session switch" : "active session"}`, async () => {
      const started = deferred();
      const response = deferred();
      const cached = new Map();
      const initial = previous.map((message) => message.id === "a2"
        ? { ...message, content: "partial reply", status: "streaming" } : message);
      const h = harness({ state: { messages: initial }, runtime: {
        loadFullSessionMessages: async () => initial,
        sessionTranscriptCache: cached,
        cacheSessionTranscript: (id, messages) => cached.set(id, messages),
      }, api: { deleteSessionMessage: async () => {
        started.resolve();
        await response.promise;
        if (outcome === "failure") throw new Error("delete failed");
        return { ok: true, deleted: false, deletedCount: 0 };
      } } });
      const deleting = h.actions.deleteMessage("u1");
      await started.promise;
      const completed = { ...row("a2", "assistant"), content: "late completed reply" };
      const live = [...h.state().messages.map((message) => message.id === "a2" ? completed : message),
        row("u3", "user"), { ...row("a3", "assistant"), status: "streaming" }];
      const other = [row("other", "user")];
      cached.set("s", live);
      h.update({ activeSessionId: switchSession ? "other" : "s", messages: switchSession ? other : live,
        isRunning: true, runningSessions: { s: true, ...(switchSession ? { other: true } : {}) } });
      response.resolve();
      await deleting;
      const restored = [...previous.slice(0, 3), row("u2", "user"), completed,
        row("u3", "user"), { ...row("a3", "assistant"), status: "streaming" }];
      assert.deepEqual(cached.get("s"), restored);
      assert.deepEqual(h.state().messages, switchSession ? other : restored);
      assert.equal(h.state().isRunning, true);
      assert.equal(h.state().runningSessions.s, true);
      assert.equal(h.state().error, outcome === "failure" ? "delete failed" : null);
    });
  }
}

for (const outcome of ["no-op", "failure"]) {
  for (const switchSession of [false, true]) {
    test(`${outcome} delete preserves a native terminal re-key across ${switchSession ? "session switch" : "active session"}`, async () => {
      const started = deferred();
      const response = deferred();
      const provisional = { ...row("provisional", "assistant"), content: "partial", status: "streaming" };
      const initial = [...previous, provisional];
      const cached = new Map();
      const h = harness({ state: { messages: initial }, runtime: {
        loadFullSessionMessages: async () => initial,
        sessionTranscriptCache: cached,
        cacheSessionTranscript: (id, messages) => cached.set(id, messages),
      }, api: { deleteSessionMessage: async () => {
        started.resolve();
        await response.promise;
        if (outcome === "failure") throw new Error("delete failed");
        return { ok: true, deleted: false, deletedCount: 0 };
      } } });
      const deleting = h.actions.deleteMessage("provisional");
      await started.promise;
      const completed = { ...row("durable-sdk", "assistant"), content: "canonical completion" };
      const event = { type: "message_end", replacesMessageId: "provisional", message: completed };
      const live = [...transcript.projectMessageEnd(h.state().messages, event), row("u3", "user")];
      cached.set("s", live);
      const other = [row("other", "user")];
      h.update({ activeSessionId: switchSession ? "other" : "s", messages: switchSession ? other : live });
      response.resolve();
      await deleting;
      const expected = [...previous, completed, row("u3", "user")];
      assert.deepEqual(cached.get("s"), expected);
      assert.deepEqual(h.state().messages, switchSession ? other : expected);
      assert.equal(h.state().error, outcome === "failure" ? "delete failed" : null);
    });
  }
}

for (const { switchSession, evictCache } of [
  { switchSession: false, evictCache: false },
  { switchSession: true, evictCache: false },
  { switchSession: true, evictCache: true },
]) {
  test(`acknowledged user-turn delete preserves a newer native completion after ${switchSession ? "session switch" : "active session"}${evictCache ? " with evicted cache" : ""}`, async () => {
    const started = deferred();
    const response = deferred();
    const initial = [...previous, { ...row("provisional", "assistant"), status: "streaming" }];
    const cached = new Map();
    const h = harness({ state: { messages: initial, retainedTranscripts: { s: initial, other: [row("other", "user")] } }, runtime: {
      loadFullSessionMessages: async () => initial,
      sessionTranscriptCache: cached,
      cacheSessionTranscript: (id, messages) => cached.set(id, messages),
    }, api: { deleteSessionMessage: async () => {
      started.resolve(); await response.promise;
      return { ok: true, deleted: true, deletedCount: 3 };
    } } });
    const deleting = h.actions.deleteMessage("u2");
    await started.promise;
    assert.deepEqual(h.state().messages, initial, "visible history changes only after Host acknowledgment");
    const completed = row("durable-sdk", "assistant");
    const live = [...transcript.projectMessageEnd(h.state().messages, {
      type: "message_end", replacesMessageId: "provisional", message: completed,
    }), row("u3", "user"), row("a3", "assistant")];
    const other = [row("other", "user")];
    cached.set("s", live);
    h.update({ activeSessionId: switchSession ? "other" : "s", messages: switchSession ? other : live, retainedTranscripts: { s: live, other } });
    if (evictCache) cached.delete("s");
    response.resolve(); await deleting;
    const expected = [...previous.slice(0, 3), row("u3", "user"), row("a3", "assistant")];
    assert.deepEqual(cached.get("s"), expected);
    assert.deepEqual(h.state().retainedTranscripts.s, expected, "retained panes must publish the same acknowledged deletion");
    assert.deepEqual(h.state().retainedTranscripts.other, other);
    assert.deepEqual(h.state().messages, switchSession ? other : expected);
  });
}
