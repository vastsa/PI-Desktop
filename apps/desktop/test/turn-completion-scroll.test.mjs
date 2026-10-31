import assert from "node:assert/strict";
import test from "node:test";
import {
  settledTurn,
  TURN_COMPLETION_TOP_INSET_PX,
  turnAnchorScrollTop,
} from "../src/lib/turn-completion-scroll.ts";

const createdAt = "2026-10-28T00:00:00.000Z";
const user = (id) => ({ id, role: "user", content: id, createdAt });
const reply = (id, status) => ({ id, role: "assistant", content: id, createdAt, status });
const tool = (id) => ({ id, role: "tool", content: id, createdAt, toolStatus: "success" });

test("a completed reply anchors on the prompt that started its turn", () => {
  assert.deepEqual(
    settledTurn([user("u1"), reply("a1", "complete"), user("u2"), tool("t1"), reply("a2", "complete")]),
    { kind: "complete", userMessageId: "u2" },
  );
});

test("a reply still streaming its final status is pending", () => {
  assert.deepEqual(settledTurn([user("u1"), reply("a1", "streaming")]), { kind: "pending" });
});

test("failed, aborted, and reply-less turns are left alone", () => {
  assert.deepEqual(settledTurn([user("u1"), reply("a1", "error")]), { kind: "none" });
  assert.deepEqual(settledTurn([user("u1"), reply("a1", "aborted")]), { kind: "none" });
  assert.deepEqual(settledTurn([user("u1"), tool("t1")]), { kind: "none" });
  assert.deepEqual(settledTurn([reply("a0", "complete")]), { kind: "none" });
  assert.deepEqual(settledTurn([]), { kind: "none" });
});

test("an earlier reply does not stand in for the newest prompt's missing one", () => {
  assert.deepEqual(settledTurn([user("u1"), reply("a1", "complete"), user("u2")]), { kind: "none" });
});

test("the prompt moves to the top inset when it is above the viewport", () => {
  assert.equal(
    turnAnchorScrollTop({ rowTop: -1_900, viewportTop: 10, scrollTop: 2_000, maxScrollTop: 2_000 }),
    2_000 - 1_910 - TURN_COMPLETION_TOP_INSET_PX,
  );
});

test("a prompt already in view needs no move", () => {
  assert.equal(
    turnAnchorScrollTop({ rowTop: 40, viewportTop: 10, scrollTop: 2_000, maxScrollTop: 2_000 }),
    null,
  );
});

test("a prompt tucked under the top inset is lifted clear of it", () => {
  assert.equal(
    turnAnchorScrollTop({ rowTop: 30, viewportTop: 10, scrollTop: 2_000, maxScrollTop: 2_000, inset: 62 }),
    2_000 + 20 - 62,
  );
});

test("the target is clamped to the scroll range", () => {
  assert.equal(
    turnAnchorScrollTop({ rowTop: -500, viewportTop: 0, scrollTop: 100, maxScrollTop: 2_000 }),
    0,
  );
});

test("unusable geometry is never acted on", () => {
  assert.equal(
    turnAnchorScrollTop({ rowTop: Number.NaN, viewportTop: 0, scrollTop: 100, maxScrollTop: 200 }),
    null,
  );
});
