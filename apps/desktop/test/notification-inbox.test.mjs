import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inboxNotifications,
  inboxUnreadCount,
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

test("inbox hides successful completions and keeps failures in order", () => {
  const rows = inboxNotifications([
    notification({ id: "done-1" }),
    notification({ id: "failed-1", kind: "task.failed" }),
    notification({ id: "done-2", readAt: "2026-09-04T10:01:00.000Z" }),
    notification({ id: "failed-2", kind: "task.failed", readAt: "2026-09-04T10:02:00.000Z" }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["failed-1", "failed-2"],
  );
});

test("inbox unread count ignores unread completions", () => {
  assert.equal(
    inboxUnreadCount([
      notification({ id: "done-1" }),
      notification({ id: "done-2" }),
      notification({ id: "failed-1", kind: "task.failed" }),
      notification({ id: "failed-2", kind: "task.failed", readAt: "2026-09-04T10:02:00.000Z" }),
    ]),
    1,
  );
  assert.equal(inboxUnreadCount([notification({ id: "done-1" })]), 0);
});

test("notification center renders the filtered inbox instead of the raw store", () => {
  assert.match(componentSource, /inboxNotifications\(storedNotifications\)/);
  assert.match(componentSource, /inboxUnreadCount\(storedNotifications\)/);
  assert.doesNotMatch(componentSource, /state\.unreadNotificationCount/);
});
