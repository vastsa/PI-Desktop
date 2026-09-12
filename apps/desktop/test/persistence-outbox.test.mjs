import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

const silent = () => undefined;

test("session delete drops the outbox for that session (D318)", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  assert.match(main, /await persistenceOutbox\.dropSession\(id\)/);
});

test("handshake drains the outbox before the renderer can hydrate (D327)", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  assert.match(main, /await persistenceOutbox\.flush\(\(\) => host\)/);
  assert.doesNotMatch(main, /void persistenceOutbox\.flush\(\(\) => host\)/);
  assert.match(main, /session\.recoverInflightMessages/);
});

test("message_end checkpoints the finished snapshot before settling (D327)", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /event\.type === "message_end"[\s\S]*inflightCheckpointer\.observe\([\s\S]*settleIf\(sessionId, finalId\)/,
  );
});

test("deleting a session drops its queued outbox entries (D318)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(
    {
      key: "message:keep:a",
      sessionId: "keep",
      message: { id: "a" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:gone:b",
      sessionId: "gone",
      message: { id: "b" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  await outbox.dropSession("gone");
  assert.equal(outbox.size(), 1);
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["keep"],
  );
});



test("a final reply replaces an in-flight steering checkpoint without being dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-steering-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const writes = [];
  const host = {
    isAvailable: () => true,
    call: async (_method, params) => {
      writes.push(params.message);
      if (writes.length === 1) {
        firstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
    },
  };
  const row = { key: "message:session:reply", sessionId: "session", turnId: "turn" };
  await outbox.enqueue({ ...row, message: { id: "reply", content: "partial", status: "streaming" } }, () => host);
  await started;
  await outbox.enqueue({ key: "message:session:input", sessionId: "session", message: { id: "input", content: "steer" }, turnId: "turn" }, () => host);
  await outbox.enqueue({ ...row, message: { id: "reply", content: "complete reply", status: "complete" } }, () => host);
  releaseFirst();
  await outbox.flush(() => host);
  assert.deepEqual(writes.map((message) => [message.id, message.content]), [
    ["reply", "partial"], ["reply", "complete reply"], ["input", "steer"],
  ]);
  assert.equal(outbox.size(), 0);
});
