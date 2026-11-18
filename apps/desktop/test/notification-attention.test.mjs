import assert from "node:assert/strict";
import test from "node:test";
import * as inbox from "../src/lib/notification-inbox.ts";

const ask = (sessionId, requestId) => ({ sessionId, requestId, toolCallId: requestId,
  questions: [{ question: "One?", options: [] }, { question: "Two?", options: [] }] });

test("question inbox includes background queues, once per request rather than draft question", () => {
  const queues = { a: [ask("a", "first"), ask("a", "second")], b: [ask("b", "third")] };
  assert.deepEqual(inbox.questionInboxItems(queues).map((item) => item.requestId),
    ["first", "second", "third"]);
  assert.equal(inbox.questionInboxItems(queues).length, 3);
  assert.deepEqual(inbox.questionInboxItems({}), []);
});

test("notification labels use the owning project override, never the active workspace", () => {
  const sessions = [{ id: "a", title: "A", projectPath: "D:\\work\\alpha\\" },
    { id: "b", title: "B" }];
  const meta = { "D:/work/alpha": { name: "Research" } };
  assert.deepEqual(inbox.notificationSessionLabel("a", sessions, meta),
    { sessionTitle: "A", projectName: "Research" });
  assert.deepEqual(inbox.notificationSessionLabel("b", sessions, meta),
    { sessionTitle: "B", projectName: undefined });
  assert.equal(inbox.notificationSessionLabel("a", sessions, {}).projectName, "alpha");
});

test("failure inbox filtering and original notification text stay unchanged", () => {
  const rows = [{ id: "done", kind: "task.completed", readAt: null },
    { id: "error", kind: "task.failed", readAt: null, errorCode: "ORIGINAL" }];
  assert.deepEqual(inbox.inboxNotifications(rows), [rows[1]]);
  assert.equal(inbox.inboxUnreadCount(rows), 1);
  assert.equal(rows[1].errorCode, "ORIGINAL");
});

test("notification labels never fall back to session IDs or stale title snapshots", () => {
  const id = "ae46a3f31f89a575469af5482d41d630";
  assert.equal(inbox.notificationSessionLabel(id, [], {}, id).sessionTitle, "");
  assert.equal(inbox.notificationSessionLabel(id, [{ id, title: id }], {}, id).sessionTitle, "");
  assert.equal(inbox.notificationSessionLabel(id, [{ id, title: "  Current title  " }], {}, id).sessionTitle,
    "Current title");
  assert.equal(inbox.notificationSessionLabel(id, [{ id, title: " " }], {}, "Saved title").sessionTitle,
    "Saved title");
});

test("notification context consistently combines project or sessions with the conversation title", () => {
  assert.equal(inbox.formatNotificationSessionLabel({ projectName: "Research", sessionTitle: "Run" }, "Sessions", "New task"),
    "Research · Run");
  assert.equal(inbox.formatNotificationSessionLabel({ projectName: undefined, sessionTitle: "Run" }, "Sessions", "New task"),
    "Sessions · Run");
  assert.equal(inbox.formatNotificationSessionLabel({ projectName: undefined, sessionTitle: "" }, "Sessions", "New task"),
    "Sessions · New task");
});

test("the shared badge counts durable tasks once and adds unanswered requests", () => {
  assert.equal(inbox.notificationBadgeCount(1, 0), 1, "failure or completion already included in history");
  assert.equal(inbox.notificationBadgeCount(0, 3), 3, "unread questions or approvals");
  assert.equal(inbox.notificationBadgeCount(2, 3), 5, "mixed task and interactive reminders");
  assert.equal(inbox.notificationBadgeCount(200, 2), 202, "bounded task history plus pending requests");
  assert.equal(inbox.notificationBadgeCount(0, 0), 0, "all reminders acknowledged");
  assert.equal(inbox.notificationBadgeCount(1, 1), 2, "new reminders after clear");
  assert.equal(inbox.notificationBadgeCount(0, 120), 120, "rendering owns the 99+ cap");
});
