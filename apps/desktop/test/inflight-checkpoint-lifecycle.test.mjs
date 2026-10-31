import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { InflightCheckpointer } from "../../../packages/host-runtime/src/inflight-checkpoint.ts";

const snapshot = (id, content = id, sessionId = "session") => ({
  sessionId, turnId: id,
  message: { id, role: "assistant", content, createdAt: "2026-10-27T00:00:00Z" },
});

for (const settled of [false, true]) {
  test(`flushAll awaits a started save${settled ? " after its session is settled" : " with no trailing snapshot"}`, async (t) => {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    let saved = false;
    const writer = new InflightCheckpointer(async () => {
      started.resolve();
      await gate.promise;
      saved = true;
    });
    t.after(async () => { gate.resolve(); await writer.flushAll(); writer.dispose(); });
    writer.observe(snapshot("reply"));
    await started.promise;
    if (settled) writer.settle("session");
    let flushed = false;
    const flushing = writer.flushAll().then(() => { flushed = true; });
    await nextTurn();
    assert.equal(flushed, false, "host shutdown must not outrun the checkpoint RPC");
    gate.resolve();
    await flushing;
    assert.equal(saved, true);
    assert.deepEqual(writer.pendingSessions(), []);
  });
}

test("settling a turn cannot start a newer save before the old write finishes", async (t) => {
  const gate = Promise.withResolvers();
  const oldStarted = Promise.withResolvers();
  const order = [];
  let concurrent = 0;
  let maximum = 0;
  const writer = new InflightCheckpointer(async ({ message }) => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    if (message.id === "old") { oldStarted.resolve(); await gate.promise; }
    order.push(message.id);
    concurrent--;
  });
  t.after(async () => { gate.resolve(); await writer.flushAll(); writer.dispose(); });
  writer.observe(snapshot("old"));
  await oldStarted.promise;
  writer.settle("session");
  writer.observe(snapshot("new"));
  const flushing = writer.flushAll();
  await nextTurn();
  assert.equal(maximum, 1, "a settled generation still owns its unfinished write");
  gate.resolve();
  await flushing;
  assert.deepEqual([...order], ["old", "new"]);
  assert.equal(maximum, 1);
});

test("flushAll drains a newer snapshot queued behind an existing save", async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const saved = [];
  const writer = new InflightCheckpointer(async ({ message }) => {
    if (saved.length === 0) { started.resolve(); await gate.promise; }
    saved.push(message.content);
  }, 60_000);
  t.after(async () => { gate.resolve(); await writer.flushAll(); writer.dispose(); });
  writer.observe(snapshot("reply", "first"));
  await started.promise;
  writer.observe(snapshot("reply", "latest"));
  const flushing = writer.flushAll();
  gate.resolve();
  await flushing;
  assert.deepEqual([...saved], ["first", "latest"]);
});

test("a drain does not chase snapshots accepted after its barrier", async (t) => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const firstStarted = Promise.withResolvers();
  const secondStarted = Promise.withResolvers();
  const saved = [];
  const writer = new InflightCheckpointer(async ({ message }) => {
    if (message.content === "first") { firstStarted.resolve(); await first.promise; }
    if (message.content === "target") { secondStarted.resolve(); await second.promise; }
    saved.push(message.content);
  }, 60_000);
  t.after(async () => { first.resolve(); second.resolve(); await writer.flushAll(); writer.dispose(); });
  writer.observe(snapshot("reply", "first"));
  await firstStarted.promise;
  writer.observe(snapshot("reply", "target"));
  const flushing = writer.flushAll();
  first.resolve();
  await secondStarted.promise;
  writer.observe(snapshot("reply", "later"));
  second.resolve();
  await flushing;
  assert.deepEqual([...saved], ["first", "target"]);
  assert.deepEqual(writer.pendingSessions(), ["session"]);
});

test("late settlement of an older message preserves a newer write's throttle", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const saved = [];
  const writer = new InflightCheckpointer(async ({ message }) => {
    saved.push(message.content);
    if (message.content === "first") { started.resolve(); await gate.promise; }
  }, 1000);
  t.after(async () => { gate.resolve(); await writer.flushAll(); writer.dispose(); });
  writer.observe(snapshot("new", "first"));
  await started.promise;
  writer.settleIf("session", "old");
  writer.observe(snapshot("new", "latest"));
  gate.resolve();
  await nextTurn();
  assert.deepEqual([...saved], ["first"]);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.deepEqual([...saved], ["first", "latest"]);
});

test("flushing a final message does not force writes for the next reply", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const saved = [];
  const writer = new InflightCheckpointer(async ({ message }) => {
    saved.push(message.id);
    if (message.id === "old") { started.resolve(); await gate.promise; }
  }, 1000);
  t.after(async () => { gate.resolve(); await writer.flushAll(); writer.dispose(); });
  writer.observe(snapshot("old"));
  await started.promise;
  const flushing = writer.flush("session");
  writer.observe(snapshot("new"));
  gate.resolve();
  await flushing;
  assert.deepEqual([...saved], ["old"]);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.deepEqual([...saved], ["old", "new"]);
});
