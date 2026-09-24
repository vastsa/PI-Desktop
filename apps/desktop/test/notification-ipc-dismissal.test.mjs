import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const IPC = {
  invoke: {
    notificationList: "notification.list",
    notificationMarkRead: "notification.markRead",
    notificationMarkAllRead: "notification.markAllRead",
    notificationClear: "notification.clear",
    notificationSetViewingSession: "notification.setViewingSession",
    notificationShowNative: "notification.showNative",
  },
  event: { notificationActivated: "notification.activated" },
};

class FakeNotification extends EventEmitter {
  static instances = [];
  static isSupported() {
    return true;
  }

  constructor(options) {
    super();
    this.options = options;
    this.closed = false;
    FakeNotification.instances.push(this);
  }

  show() {
    this.shown = true;
  }

  close() {
    this.closed = true;
    this.emit("close");
  }
}

function loadNotificationIpc() {
  const file = new URL("../electron/main/ipc/notification-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "electron") return { Notification: FakeNotification };
      if (id === "@pi-desktop/shared") return { IPC };
      if (id === "../notification-policy") {
        return { shouldShowNativeNotification: () => true };
      }
      throw new Error(`unexpected dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

function harness({ hostCall } = {}) {
  FakeNotification.instances = [];
  const handlers = new Map();
  const calls = [];
  const events = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return hostCall ? hostCall(method, input) : { ok: true };
    },
  };
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    isMinimized: () => false,
    show: () => {},
    focus: () => {},
    restore: () => {},
  };
  const { registerNotificationIpc } = loadNotificationIpc();
  registerNotificationIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getMainWindow: () => mainWindow,
    getViewingSessionId: () => "session-current",
    setViewingSessionId: () => {},
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
  });
  return {
    handlers,
    calls,
    events,
    show: (input) => handlers.get(IPC.invoke.notificationShowNative)(input),
    markRead: (id) => handlers.get(IPC.invoke.notificationMarkRead)({ id }),
    markAllRead: () => handlers.get(IPC.invoke.notificationMarkAllRead)(),
    clear: () => handlers.get(IPC.invoke.notificationClear)(),
  };
}

test("duplicate task delivery is idempotent and read dismissal leaves a tombstone", async () => {
  const h = harness();
  const input = {
    id: "durable-1",
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
  };

  assert.deepEqual(await h.show(input), { shown: true });
  assert.deepEqual(await h.show(input), { shown: false });
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(FakeNotification.instances[0].closed, false);

  await h.markRead(input.id);
  assert.equal(FakeNotification.instances[0].closed, true);
  assert.deepEqual(await h.show(input), { shown: false });
  assert.deepEqual(h.calls.map(({ method }) => method), [
    "notification.markRead",
  ]);
});

test("clear and mark-all-read close every task object, while interactive prompts stay independent", async () => {
  const h = harness();
  const task = (id) => ({
    id,
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
  });
  const interactive = {
    id: "same-id",
    sessionId: "session-1",
    kind: "interactive",
    title: "Approval",
    body: "Please choose",
  };

  await h.show(task("task-1"));
  await h.show(task("task-2"));
  await h.markAllRead();
  assert.deepEqual(FakeNotification.instances.map((item) => item.closed), [true, true]);

  // An interactive prompt may reuse an id without colliding with task rows.
  await h.show(interactive);
  await h.show(interactive);
  assert.equal(FakeNotification.instances.length, 4);
  assert.equal(FakeNotification.instances[2].closed, false);
  assert.equal(FakeNotification.instances[3].closed, false);

  await h.clear();
  assert.equal(FakeNotification.instances[2].closed, false);
  assert.equal(FakeNotification.instances[3].closed, false);
  assert.deepEqual(h.calls.map(({ method }) => method), [
    "notification.markAllRead",
    "notification.clear",
  ]);
});

test("acknowledgement watermarks reject old task events but allow a later turn", async () => {
  const h = harness();
  const now = Date.now();
  const task = (id, createdAt) => ({
    id,
    sessionId: "session-1",
    kind: "task",
    title: "Task finished",
    body: "Done",
    createdAt,
  });

  await h.markAllRead();
  assert.deepEqual(
    await h.show(task("before-mark-all", new Date(now - 60_000).toISOString())),
    { shown: false },
  );
  assert.deepEqual(
    await h.show(task("after-mark-all", new Date(now + 60_000).toISOString())),
    { shown: true },
  );

  await h.clear();
  assert.deepEqual(
    await h.show(task("before-clear", new Date(now - 30_000).toISOString())),
    { shown: false },
  );
  assert.deepEqual(
    await h.show(task("after-clear", new Date(now + 120_000).toISOString())),
    { shown: true },
  );
});

test("a failed host acknowledgement does not dismiss a task banner prematurely", async () => {
  const h = harness({
    hostCall: async (method) => {
      if (method === "notification.markRead") throw new Error("host unavailable");
      return { ok: true };
    },
  });
  const input = {
    id: "durable-failure",
    sessionId: "session-1",
    kind: "task",
    title: "Task failed",
    body: "Retry",
  };
  await h.show(input);
  await assert.rejects(h.markRead(input.id), /host unavailable/);
  assert.equal(FakeNotification.instances[0].closed, false);
});
