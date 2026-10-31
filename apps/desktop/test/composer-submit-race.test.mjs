import assert from "node:assert/strict";
import { test } from "node:test";
import { submitWithLatestDraftRestore } from "../src/features/chat/composer/hooks/submit-with-latest-draft-restore.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("a late rejection cannot restore over a newer accepted submission", async () => {
  const olderSend = deferred();
  const newerSend = deferred();
  const restored = [];

  const older = submitWithLatestDraftRestore("session-a", () => olderSend.promise, () => restored.push("older"));
  const newer = submitWithLatestDraftRestore("session-a", () => newerSend.promise, () => restored.push("newer"));

  newerSend.resolve(true);
  assert.equal(await newer, true);
  olderSend.resolve(false);
  assert.equal(await older, false);
  assert.deepEqual(restored, []);
});

test("an older pending send cannot regain ownership after a later slot reuse", async () => {
  const olderSend = deferred();
  const latestSend = deferred();
  const restored = [];

  const older = submitWithLatestDraftRestore("session-b", () => olderSend.promise, () => restored.push("older"));
  const latest = submitWithLatestDraftRestore("session-b", async () => true, () => restored.push("latest"));
  assert.equal(await latest, true);

  const reused = submitWithLatestDraftRestore("session-b", () => latestSend.promise, () => restored.push("reused"));
  olderSend.resolve(false);
  assert.equal(await older, false);
  assert.deepEqual(restored, []);

  latestSend.resolve(false);
  assert.equal(await reused, false);
  assert.deepEqual(restored, ["reused"]);
});
