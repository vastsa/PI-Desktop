import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

const queueFile = "session-message-outbox.json";
const archiveFile = "session-message-outbox.dead-letter.json";
const rejected = { key: "message:s:one", sessionId: "s", message: { id: "one", text: "original" } };
const healthy = { key: "message:t:two", sessionId: "t", message: { id: "two" } };

async function seedQueue(t, entries = [rejected, healthy]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-quarantine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, queueFile), JSON.stringify(entries));
  return dir;
}

async function retryFourTimes(dir, host) {
  let now = 0;
  const outbox = new PersistenceOutbox(dir, () => {}, { now: () => now });
  for (let attempt = 0; attempt < 4; attempt++) {
    await outbox.flush(() => host);
    now += 60_000;
  }
  return outbox;
}

for (const boundary of ["before", "after"]) {
  test(`restarting ${boundary} the dead-letter rename retains the rejected append exactly once`, async (t) => {
    const dir = await seedQueue(t);
    const previous = { ...rejected, quarantinedAt: "2026-01-01T00:00:00Z", reason: "earlier rejection" };
    await writeFile(join(dir, archiveFile), JSON.stringify([previous]));
    const moduleUrl = new URL("../electron/main/persistence-outbox.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const [moduleUrl, dir, archive, boundary] = process.argv.slice(1);
      const originalRename = fs.rename;
      fs.rename = async (from, to) => {
        if (to === archive && boundary === "before") process.exit(77);
        await originalRename(from, to);
        if (to === archive && boundary === "after") process.exit(77);
      };
      syncBuiltinESMExports();
      const { PersistenceOutbox } = await import(moduleUrl);
      let now = 0;
      const outbox = new PersistenceOutbox(dir, () => {}, { now: () => now });
      const host = { isAvailable: () => true, call: async () => { throw new Error("busy"); } };
      for (let attempt = 0; attempt < 5; attempt++) {
        now += 60_000;
        await outbox.flush(() => host);
      }
    `, moduleUrl, dir, join(dir, archiveFile), boundary], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 77, child.stderr || "the child must reach the archive rename");

    const recovered = new PersistenceOutbox(dir, () => {});
    const calls = [];
    const host = { isAvailable: () => true, call: async (_method, params) => calls.push(params.message) };
    // A fresh enqueue may have the same key and even the same payload as either dead letter.
    await recovered.enqueue(rejected, () => host);
    await recovered.flush(() => host);
    assert.deepEqual(calls, [healthy.message, rejected.message]);
    const archived = JSON.parse(await readFile(join(dir, archiveFile), "utf8"));
    assert.equal(archived.length, 2);
    assert.deepEqual(archived[0], previous);
    assert.deepEqual(archived[1].message, rejected.message);
    assert.match(archived[1].reason, /busy/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, queueFile), "utf8")), []);

    // The archive record itself can still be requeued explicitly for manual recovery.
    await recovered.enqueue(archived[1], () => host);
    await recovered.flush(() => host);
    assert.deepEqual(calls, [healthy.message, rejected.message, rejected.message]);
  });
}

test("a failed dead-letter write can be retried without sending the rejected append again", async (t) => {
  const dir = await seedQueue(t);
  const calls = [];
  const host = {
    isAvailable: () => true,
    call: async (_method, { message }) => {
      calls.push(message.id);
      if (message.id === rejected.message.id) throw new Error("busy");
    },
  };
  const outbox = await retryFourTimes(dir, host);
  // The archive has already been loaded. A directory at its path makes the next rename fail.
  await mkdir(join(dir, archiveFile));
  await assert.rejects(outbox.flush(() => host));
  const pending = JSON.parse(await readFile(join(dir, queueFile), "utf8"));
  assert.deepEqual(pending.map((entry) => entry.message), [rejected.message, healthy.message]);
  await rmdir(join(dir, archiveFile));

  await outbox.flush(() => null);
  const archived = JSON.parse(await readFile(join(dir, archiveFile), "utf8"));
  assert.deepEqual(archived.map((entry) => entry.message), [rejected.message]);
  await outbox.flush(() => host);
  assert.deepEqual(calls, ["one", "one", "one", "one", "one", "two"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, queueFile), "utf8")), []);
});

test("deleting the session after a failed queue cleanup also clears the pending transfer", async (t) => {
  const dir = await seedQueue(t);
  const host = { isAvailable: () => true, call: async () => { throw new Error("busy"); } };
  const outbox = await retryFourTimes(dir, host);
  const originalRename = fs.rename;
  let archiveCommitted = false;
  const rename = t.mock.method(fs, "rename", async (from, to) => {
    if (archiveCommitted && to === join(dir, queueFile)) {
      archiveCommitted = false;
      throw Object.assign(new Error("queue rename denied"), { code: "EPERM" });
    }
    await originalRename(from, to);
    if (to === join(dir, archiveFile)) archiveCommitted = true;
  });
  syncBuiltinESMExports();
  t.after(() => {
    rename.mock.restore();
    syncBuiltinESMExports();
  });

  await assert.rejects(outbox.flush(() => host), { code: "EPERM" });
  await outbox.dropSession(rejected.sessionId);
  assert.deepEqual(JSON.parse(await readFile(join(dir, queueFile), "utf8")).map((entry) => entry.key), [healthy.key]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, archiveFile), "utf8")), []);
});

for (const change of ["replacement", "deletion", "deletion and re-enqueue"]) {
  test(`quarantine respects a concurrent ${change} during the final host attempt`, async (t) => {
    const dir = await seedQueue(t, [rejected]);
    await writeFile(join(dir, archiveFile), "[]");
    const started = Promise.withResolvers();
    const finalAttempt = Promise.withResolvers();
    const delivered = [];
    let failures = 0;
    const host = {
      isAvailable: () => true,
      call: async (_method, { message }) => {
        if (message.text !== "original") return delivered.push(message);
        if (++failures === 5) {
          started.resolve();
          return finalAttempt.promise;
        }
        throw new Error("busy");
      },
    };
    const outbox = await retryFourTimes(dir, host);
    const flush = outbox.flush(() => host);
    await started.promise;
    const replacement = { ...rejected, message: { ...rejected.message, text: "updated" } };
    if (change !== "replacement") await outbox.dropSession(rejected.sessionId);
    if (change !== "deletion") await outbox.enqueue(replacement, () => host);
    finalAttempt.reject(new Error("busy"));
    await flush;

    const archived = JSON.parse(await readFile(join(dir, archiveFile), "utf8"));
    assert.deepEqual(archived.map((entry) => entry.message), change === "replacement" ? [rejected.message] : []);
    assert.deepEqual(delivered, change === "deletion" ? [] : [replacement.message]);
  });
}
