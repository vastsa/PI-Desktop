import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { refreshActiveRemoteSession } = await import(
  "../src/features/app/remote-session-resync.ts"
);

test("a visible resynced remote session reloads without adding a navigation entry", async () => {
  const calls = [];
  await refreshActiveRemoteSession(
    { reason: "remote.host.reconnected", sessionResyncIds: ["remote:hostA:s1"] },
    () => ({
      page: "chat",
      activeSessionId: "remote:hostA:s1",
      selectSession: async (...args) => calls.push(args),
    }),
  );

  assert.deepEqual(calls, [["remote:hostA:s1", { record: false }]]);
});

test("a resync does not take focus from another page or session", async () => {
  const calls = [];
  const event = {
    reason: "remote.host.reconnected",
    sessionResyncIds: ["remote:hostA:s1"],
  };

  await refreshActiveRemoteSession(event, () => ({
    page: "settings",
    activeSessionId: "remote:hostA:s1",
    selectSession: async (...args) => calls.push(args),
  }));
  await refreshActiveRemoteSession(event, () => ({
    page: "chat",
    activeSessionId: "local:s2",
    selectSession: async (...args) => calls.push(args),
  }));

  assert.deepEqual(calls, []);
});

test("a closed session subscription refreshes its visible resynced transcript", async () => {
  const calls = [];
  await refreshActiveRemoteSession(
    { reason: "remote.session.resynced", sessionResyncIds: ["remote:hostA:s1"] },
    () => ({
      page: "chat",
      activeSessionId: "remote:hostA:s1",
      selectSession: async (...args) => calls.push(args),
    }),
  );

  assert.deepEqual(calls, [["remote:hostA:s1", { record: false }]]);
});
