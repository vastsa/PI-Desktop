import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  inboxNotifications,
  inboxUnreadCount,
} from "../src/lib/notification-inbox.ts";

const IPC = {
  invoke: {
    notificationMarkRead: "pi-desktop/notification/markRead",
    notificationMarkAllRead: "pi-desktop/notification/markAllRead",
    notificationClear: "pi-desktop/notification/clear",
  },
  event: {
    notificationChanged: "pi-desktop/notification/event/changed",
    hostStatus: "pi-desktop/app/event/hostStatus",
  },
};

function loadBadgeModule({ renderPng } = {}) {
  const file = new URL("../electron/main/taskbar-unread-badge.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file.pathname,
  });

  const badgeCounts = [];
  const resizeCalls = [];
  const createFromBufferCalls = [];
  function makeFakeNativeImage(buffer) {
    return {
      isEmpty: () => !buffer || buffer.length === 0,
      buffer,
      resize(options) {
        resizeCalls.push(options);
        return makeFakeNativeImage(buffer);
      },
    };
  }
  const electron = {
    app: {
      setBadgeCount(count) {
        badgeCounts.push(count);
      },
    },
    nativeImage: {
      createFromBuffer(buffer, options) {
        createFromBufferCalls.push({
          bufferLength: buffer?.length ?? 0,
          scaleFactor: options?.scaleFactor,
        });
        return makeFakeNativeImage(buffer);
      },
      createFromDataURL(url) {
        const prefix = "data:image/png;base64,";
        const b64 = typeof url === "string" && url.startsWith(prefix)
          ? url.slice(prefix.length)
          : "";
        const buffer = Buffer.from(b64, "base64");
        return makeFakeNativeImage(buffer);
      },
    },
  };

  const syncPngCalls = [];
  const canvasPngCalls = [];
  const overlay = {
    TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR: 3,
    buildTaskbarUnreadOverlayPng(count) {
      syncPngCalls.push(count);
      if (count <= 0) return null;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, count & 0xff]);
    },
    async renderTaskbarUnreadOverlayPng(_contents, count) {
      canvasPngCalls.push(count);
      if (renderPng) return renderPng(count);
      if (count <= 0) return null;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0xca, count & 0xff]);
    },
    formatTaskbarUnreadOverlayLabel(count) {
      if (count <= 0) return null;
      return count >= 100 ? "99+" : String(count);
    },
  };

  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "electron") return electron;
      if (id === "@pi-desktop/shared") return { IPC };
      if (id === "./taskbar-unread-overlay") return overlay;
      throw new Error(`unexpected dependency: ${id}`);
    },
    module.exports,
    module,
  );

  return {
    createTaskbarUnreadBadge: module.exports.createTaskbarUnreadBadge,
    badgeCounts,
    syncPngCalls,
    canvasPngCalls,
    resizeCalls,
    createFromBufferCalls,
  };
}

function makeWindow(overlayIcons) {
  return {
    isDestroyed: () => false,
    setOverlayIcon(image, description) {
      overlayIcons.push({ image, description });
    },
    webContents: {
      isDestroyed: () => false,
      async executeJavaScript() {
        return null;
      },
    },
  };
}

function harness({ platform = "linux", unreadCount = 0, windowReady = true, renderPng } = {}) {
  const previousPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  const loaded = loadBadgeModule({ renderPng });
  const listCalls = [];
  const overlayIcons = [];
  let currentUnread = unreadCount;
  let hostRef = {
    call: async (method, input) => {
      listCalls.push({ method, input });
      assert.equal(method, "notification.list");
      return { notifications: [], unreadCount: currentUnread };
    },
  };
  let mainWindow = windowReady ? makeWindow(overlayIcons) : null;

  const badge = loaded.createTaskbarUnreadBadge({
    getHost: () => hostRef,
    getMainWindow: () => mainWindow,
    isQuitting: () => false,
    logger: { app() {} },
  });

  return {
    badge,
    listCalls,
    badgeCounts: loaded.badgeCounts,
    syncPngCalls: loaded.syncPngCalls,
    canvasPngCalls: loaded.canvasPngCalls,
    resizeCalls: loaded.resizeCalls,
    createFromBufferCalls: loaded.createFromBufferCalls,
    overlayIcons,
    setUnreadCount(next) {
      currentUnread = next;
    },
    setMainWindow(next) {
      mainWindow = next;
    },
    makeWindow() {
      mainWindow = makeWindow(overlayIcons);
      return mainWindow;
    },
    dispose() {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: previousPlatform,
      });
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("observeInvoke on markRead triggers notification.list refresh", async () => {
  const h = harness({ platform: "linux", unreadCount: 3 });
  try {
    h.badge.observeInvoke(IPC.invoke.notificationMarkRead);
    await waitFor(() => h.listCalls.length >= 1);
    assert.equal(h.listCalls[0].method, "notification.list");
    assert.deepEqual(h.listCalls[0].input, { limit: 1 });
    await waitFor(() => h.badgeCounts.includes(3));
    assert.equal(h.badgeCounts.at(-1), 3);
  } finally {
    h.dispose();
  }
});

test("observeInvoke on markAllRead and clear also refresh", async () => {
  for (const channel of [
    IPC.invoke.notificationMarkAllRead,
    IPC.invoke.notificationClear,
  ]) {
    const h = harness({ platform: "linux", unreadCount: 1 });
    try {
      h.badge.observeInvoke(channel);
      await waitFor(() => h.listCalls.length >= 1);
      assert.equal(h.listCalls[0].method, "notification.list");
      await waitFor(() => h.badgeCounts.length >= 1);
      assert.equal(h.badgeCounts.at(-1), 1);
    } finally {
      h.dispose();
    }
  }
});

test("observeInvoke ignores unrelated channels", async () => {
  const h = harness({ platform: "linux", unreadCount: 9 });
  try {
    h.badge.observeInvoke("pi-desktop/session/list");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.listCalls.length, 0);
    assert.equal(h.badgeCounts.length, 0);
  } finally {
    h.dispose();
  }
});

test("observeEvent(notificationChanged) refreshes from host unreadCount", async () => {
  const h = harness({ platform: "linux", unreadCount: 5 });
  try {
    h.badge.observeEvent(IPC.event.notificationChanged, {});
    await waitFor(() => h.listCalls.length >= 1);
    await waitFor(() => h.badgeCounts.includes(5));
    assert.equal(h.badgeCounts.at(-1), 5);
  } finally {
    h.dispose();
  }
});

test("refresh applies host unreadCount to the shell badge", async () => {
  const h = harness({ platform: "linux", unreadCount: 7 });
  try {
    await h.badge.refresh();
    assert.equal(h.listCalls.length, 1);
    assert.equal(h.badgeCounts.at(-1), 7);
  } finally {
    h.dispose();
  }
});

test("refresh with unreadCount 0 clears the shell badge", async () => {
  const h = harness({ platform: "linux", unreadCount: 4 });
  try {
    await h.badge.refresh();
    assert.equal(h.badgeCounts.at(-1), 4);
    h.setUnreadCount(0);
    await h.badge.refresh();
    assert.equal(h.badgeCounts.at(-1), 0);
  } finally {
    h.dispose();
  }
});

test("refresh with unreadCount 0 clears the Windows overlay icon", async () => {
  const h = harness({ platform: "win32", unreadCount: 2 });
  try {
    await h.badge.refresh();
    assert.ok(h.overlayIcons.length >= 1);
    assert.notEqual(h.overlayIcons.at(-1).image, null);
    assert.equal(h.overlayIcons.at(-1).description, "2");
    assert.ok(h.canvasPngCalls.includes(2));

    h.setUnreadCount(0);
    await h.badge.refresh();
    assert.equal(h.overlayIcons.at(-1).image, null);
    assert.equal(h.overlayIcons.at(-1).description, "");
  } finally {
    h.dispose();
  }
});

test("Windows: refresh before window is ready keeps the update for replay", async () => {
  const h = harness({ platform: "win32", unreadCount: 3, windowReady: false });
  try {
    await h.badge.refresh();
    assert.equal(h.listCalls.length, 1);
    assert.equal(h.overlayIcons.length, 0, "no overlay while window is missing");

    // Same count again must not be treated as already applied.
    await h.badge.refresh();
    assert.equal(h.overlayIcons.length, 0);

    h.makeWindow();
    h.badge.replay();
    await waitFor(() => h.overlayIcons.length >= 1);
    assert.equal(h.overlayIcons.length, 1);
    assert.notEqual(h.overlayIcons[0].image, null);
    assert.equal(h.overlayIcons[0].description, "3");
  } finally {
    h.dispose();
  }
});

test("Windows: createTray-style replay paints after late window readiness", async () => {
  const h = harness({ platform: "win32", unreadCount: 2, windowReady: false });
  try {
    h.badge.observeEvent(IPC.event.notificationChanged, { reason: "insert" });
    await waitFor(() => h.listCalls.length >= 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.overlayIcons.length, 0);

    h.makeWindow();
    // createTray calls refresh() then replay().
    await h.badge.refresh();
    h.badge.replay();
    await waitFor(() => h.overlayIcons.length >= 1);
    assert.ok(h.overlayIcons.length >= 1);
    assert.equal(h.overlayIcons.at(-1).description, "2");
  } finally {
    h.dispose();
  }
});

test("Windows: uses smooth Canvas PNG with scaleFactor 3 and no resize", async () => {
  const h = harness({ platform: "win32", unreadCount: 9 });
  try {
    await h.badge.refresh();
    assert.ok(h.canvasPngCalls.includes(9));
    assert.equal(h.syncPngCalls.length, 0);
    assert.equal(h.overlayIcons.at(-1).description, "9");
    assert.ok(h.createFromBufferCalls.length >= 1);
    assert.equal(h.createFromBufferCalls.at(-1).scaleFactor, 3);
    assert.equal(h.resizeCalls.length, 0, "must not intermediate-resize overlay");
  } finally {
    h.dispose();
  }
});

test("Windows: falls back to the bitmap if Canvas rendering fails", async () => {
  const h = harness({
    platform: "win32",
    unreadCount: 4,
    renderPng: async () => { throw new Error("renderer unavailable"); },
  });
  try {
    await h.badge.refresh();
    assert.deepEqual(h.canvasPngCalls, [4]);
    assert.deepEqual(h.syncPngCalls, [4]);
    assert.equal(h.overlayIcons.at(-1).description, "4");
  } finally {
    h.dispose();
  }
});

test("Windows: a delayed Canvas result cannot replace a newer paint", async () => {
  let finishFirst;
  const firstRender = new Promise((resolve) => { finishFirst = resolve; });
  let renderCount = 0;
  const h = harness({
    platform: "win32",
    unreadCount: 1,
    renderPng: () => ++renderCount === 1
      ? firstRender
      : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  try {
    const firstRefresh = h.badge.refresh();
    await waitFor(() => h.canvasPngCalls.includes(1));
    h.badge.replay();
    await waitFor(() => h.overlayIcons.length === 1);
    finishFirst(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await firstRefresh;
    assert.equal(h.overlayIcons.length, 1, "stale first paint must not apply");
  } finally {
    h.dispose();
  }
});

test("badge source has no image.resize and imports the Canvas renderer", () => {
  const source = readFileSync(
    new URL("../electron/main/taskbar-unread-badge.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /image\.resize/);
  assert.doesNotMatch(source, /resize\s*\(/);
  assert.match(source, /renderTaskbarUnreadOverlayPng/);
  assert.match(source, /scaleFactor:\s*TASKBAR_UNREAD_OVERLAY_SCALE_FACTOR/);
  assert.match(source, /buildTaskbarUnreadOverlayPng/);
});

test("D295 inbox still counts failures only while shell uses full unreadCount", () => {
  const rows = [
    {
      id: "c1",
      kind: "task.completed",
      sessionId: "s",
      sessionTitle: "S",
      turnId: "t1",
      createdAt: "2026-09-24T00:00:00.000Z",
      readAt: null,
    },
    {
      id: "f1",
      kind: "task.failed",
      sessionId: "s",
      sessionTitle: "S",
      turnId: "t2",
      createdAt: "2026-09-24T00:00:01.000Z",
      readAt: null,
    },
    {
      id: "c2",
      kind: "task.completed",
      sessionId: "s",
      sessionTitle: "S",
      turnId: "t3",
      createdAt: "2026-09-24T00:00:02.000Z",
      readAt: null,
    },
  ];
  assert.deepEqual(
    inboxNotifications(rows).map((row) => row.id),
    ["f1"],
  );
  assert.equal(inboxUnreadCount(rows), 1);
  // Shell badge path reads host unreadCount (completed + failed) — 3 here.
  assert.equal(rows.filter((row) => row.readAt == null).length, 3);
});
