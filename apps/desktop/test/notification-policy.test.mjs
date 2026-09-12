import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldCreateTaskNotification,
  shouldShowNativeNotification,
} from "../electron/main/notification-policy.ts";

const focusedCurrent = {
  finishingSessionId: "session-a",
  viewingSessionId: "session-a",
  windowVisible: true,
  windowFocused: true,
};

test("suppresses a focused completion for the exact visible session", () => {
  assert.equal(shouldCreateTaskNotification(focusedCurrent), false);
});

test("keeps notifications for focused background sessions", () => {
  assert.equal(
    shouldCreateTaskNotification({
      ...focusedCurrent,
      finishingSessionId: "session-b",
    }),
    true,
  );
});

test("keeps notifications when the current session is unfocused or hidden", () => {
  assert.equal(
    shouldCreateTaskNotification({ ...focusedCurrent, windowFocused: false }),
    true,
  );
  assert.equal(
    shouldCreateTaskNotification({ ...focusedCurrent, windowVisible: false }),
    true,
  );
});

test("fails safe when the viewing context is unknown", () => {
  assert.equal(
    shouldCreateTaskNotification({ ...focusedCurrent, viewingSessionId: null }),
    true,
  );
});


test("suppresses focused task banners for background sessions", () => {
  assert.equal(
    shouldShowNativeNotification({
      kind: "task",
      sessionId: "session-b",
      viewingSessionId: "session-a",
      windowVisible: true,
      windowFocused: true,
    }),
    false,
  );
});

test("shows task banners only when the window is unfocused", () => {
  assert.equal(
    shouldShowNativeNotification({
      kind: "task",
      sessionId: "session-a",
      viewingSessionId: "session-a",
      windowVisible: true,
      windowFocused: false,
    }),
    true,
  );
  assert.equal(
    shouldShowNativeNotification({
      kind: "task",
      sessionId: "session-a",
      viewingSessionId: "session-a",
      windowVisible: false,
      windowFocused: true,
    }),
    true,
  );
});

test("preserves focused background banners for interactive prompts", () => {
  assert.equal(
    shouldShowNativeNotification({
      kind: "interactive",
      sessionId: "session-b",
      viewingSessionId: "session-a",
      windowVisible: true,
      windowFocused: true,
    }),
    true,
  );
  assert.equal(
    shouldShowNativeNotification({
      kind: "interactive",
      sessionId: "session-a",
      viewingSessionId: "session-a",
      windowVisible: true,
      windowFocused: true,
    }),
    false,
  );
});
