import assert from "node:assert/strict";
import test from "node:test";

import { createLatestCommitQueue } from "../src/features/chat/composer/thinking-commit-queue.ts";

test("latest-wins drops values that arrive while a send is in flight", async () => {
  const sent = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const queue = createLatestCommitQueue({
    send: async (value) => {
      sent.push(value);
      if (sent.length === 1) await firstGate;
    },
  });

  const first = queue.commit("low");
  const middle = queue.commit("medium");
  const last = queue.commit("high");
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await middle, true);
  assert.equal(await last, true);
  assert.deepEqual(sent, ["low", "high"]);
});

test("invalidate drops pending work and fails the in-flight waiter", async () => {
  const sent = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const queue = createLatestCommitQueue({
    send: async (value) => {
      sent.push(value);
      if (sent.length === 1) await firstGate;
    },
  });

  const first = queue.commit("low");
  void queue.commit("medium");
  queue.invalidate();
  releaseFirst();
  assert.equal(await first, false);
  await queue.idle();
  assert.deepEqual(sent, ["low"]);
});

test("a commit after invalidate is sent once the previous write settles", async () => {
  const sent = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const queue = createLatestCommitQueue({
    send: async (value) => {
      sent.push(value);
      if (value === "low") await firstGate;
    },
  });

  const first = queue.commit("low");
  queue.invalidate();
  const next = queue.commit("high");
  releaseFirst();
  assert.equal(await first, false);
  assert.equal(await next, true);
  assert.deepEqual(sent, ["low", "high"]);
});

test("send errors toast once and do not flush a newer pending value", async () => {
  const sent = [];
  const errors = [];
  const queue = createLatestCommitQueue({
    send: async (value) => {
      sent.push(value);
      throw new Error(`fail ${value}`);
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  const first = queue.commit("low");
  const second = queue.commit("high");
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.deepEqual(sent, ["low"]);
  assert.deepEqual(errors, ["fail low"]);
});
