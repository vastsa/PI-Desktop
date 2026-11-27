import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inboxNotifications,
  inboxUnreadCount,
  notificationTarget,
} from "../src/lib/notification-inbox.ts";

const componentSource = await readFile(
  new URL("../src/components/NotificationCenter.tsx", import.meta.url),
  "utf8",
);

function notification(overrides) {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("inbox lists every outcome, unread first, failures next, newest first (D689)", () => {
  const input = [
    notification({
      id: "done-read-new",
      readAt: "2026-09-04T10:05:00.000Z",
      createdAt: "2026-09-04T12:00:00.000Z",
    }),
    notification({
      id: "failed-read",
      kind: "task.failed",
      readAt: "2026-09-04T10:01:00.000Z",
      createdAt: "2026-09-04T09:00:00.000Z",
    }),
    notification({ id: "done-unread-old", createdAt: "2026-09-04T08:00:00.000Z" }),
    notification({
      id: "failed-unread-new",
      kind: "task.failed",
      createdAt: "2026-09-04T11:00:00.000Z",
    }),
  ];
  const rows = inboxNotifications(input);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["failed-unread-new", "done-unread-old", "failed-read", "done-read-new"],
  );
  // Ordering only: the store array the popover receives is left untouched.
  assert.deepEqual(
    input.map((row) => row.id),
    ["done-read-new", "failed-read", "done-unread-old", "failed-unread-new"],
  );
});

test("inbox unread count counts the rows the popover shows", () => {
  const rows = [
    notification({ id: "done-1" }),
    notification({ id: "done-2" }),
    notification({ id: "failed-1", kind: "task.failed" }),
    notification({
      id: "failed-2",
      kind: "task.failed",
      readAt: "2026-09-04T10:02:00.000Z",
    }),
  ];
  // Completed rows stay countable, so the bell badge matches the shell badge
  // that counts every unread durable row.
  assert.equal(inboxUnreadCount(rows), 3);
  assert.equal(inboxUnreadCount(rows), rows.filter((row) => !row.readAt).length);
  assert.equal(inboxUnreadCount([]), 0);
});

test("a scheduled run targets the Scheduled page, every other row its session", () => {
  const sessions = [
    { id: "session-1", scheduledRun: false },
    { id: "session-2", scheduledRun: true },
    { id: "session-3" },
  ];
  assert.equal(
    notificationTarget(notification({ sessionId: "session-2" }), sessions),
    "scheduled",
  );
  assert.equal(
    notificationTarget(notification({ sessionId: "session-1" }), sessions),
    "session",
  );
  assert.equal(
    notificationTarget(notification({ sessionId: "session-3" }), sessions),
    "session",
  );
  // A row whose session is no longer loaded keeps the ordinary activation.
  assert.equal(
    notificationTarget(notification({ sessionId: "missing" }), sessions),
    "session",
  );
  assert.equal(notificationTarget(notification({}), []), "session");
});

test("notification center renders the ordered inbox instead of the raw store", () => {
  assert.match(componentSource, /inboxNotifications\(storedNotifications\)/);
  assert.match(componentSource, /inboxUnreadCount\(storedNotifications\)/);
});

test("scheduled run rows mark read and open the Scheduled page", () => {
  assert.match(
    componentSource,
    /notificationTarget\(notification, sessions\) === "scheduled"/,
  );
  assert.match(componentSource, /await markNotificationRead\(notification\.id\);/);
  assert.match(componentSource, /setPage\("scheduled"\)/);
  assert.match(componentSource, /t\("notifications\.scheduledRunSource"\)/);
  // Ordinary rows keep the existing open path.
  assert.match(componentSource, /await openNotification\(notification\.id\);/);
});

test("notification center actions can clear taskbar-only completed outcomes", () => {
  assert.match(componentSource, /const allUnreadCount = useAppStore\(/);
  assert.match(componentSource, /state\.unreadNotificationCount/);
  assert.match(componentSource, /disabled=\{busy \|\| allUnreadCount === 0\}/);
  assert.match(componentSource, /disabled=\{busy \|\| storedNotifications\.length === 0\}/);
});