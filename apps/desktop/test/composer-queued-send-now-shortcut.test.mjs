import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { slotSsr } from "./helpers/slot-ssr.mjs";
import {
  readComposerModule,
  readComposerSource,
} from "./helpers/source-contracts.mjs";

async function loadQueuedPrompts(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return server.ssrLoadModule("/src/lib/queued-prompts.ts");
}

function queuedFixture(overrides) {
  return {
    id: "prompt-1",
    sessionId: "session-a",
    content: "follow up",
    draft: { text: "", fileReferences: [] },
    createdAt: 1,
    ...overrides,
  };
}

test("next sendable queued prompt skips saving and already promoted rows", async (t) => {
  const { nextSendableQueuedPrompt } = await loadQueuedPrompts(t);

  assert.equal(nextSendableQueuedPrompt([]), undefined);

  const waiting = queuedFixture({ id: "prompt-waiting" });
  assert.equal(
    nextSendableQueuedPrompt([
      queuedFixture({ id: "pending:1" }),
      queuedFixture({ id: "prompt-promoted", priority: 0 }),
      waiting,
    ]),
    waiting,
  );

  assert.equal(
    nextSendableQueuedPrompt([
      queuedFixture({ id: "pending:1" }),
      queuedFixture({ id: "prompt-promoted", priority: 0 }),
    ]),
    undefined,
  );
});

test("the composer submit path promotes a waiting row only for an empty steer", async (t) => {
  const ssr = await slotSsr(t);
  const { useComposerSubmit } = await ssr.load("/src/features/chat/composer/hooks/useComposerSubmit.ts");
  const calls = [];
  const waiting = queuedFixture({ id: "prompt-waiting" });
  const queuedPrompts = [
    queuedFixture({ id: "pending:1" }),
    queuedFixture({ id: "prompt-promoted", priority: 0 }),
    waiting,
  ];
  const makeSubmit = (overrides = {}) => useComposerSubmit({
    value: "", draftKey: "session-a", activeSessionId: "session-a",
    modelReady: true, sendBlocked: false, steeringAllowed: true,
    invalidateComposerTransforms() {}, pasting: false, activeFileReferences: [],
    t: (key) => key, showToast() {}, queuedPrompts,
    sendPrompt: async (...args) => { calls.push(["prompt", ...args]); return true; },
    steerPrompt: async (...args) => { calls.push(["steer", ...args]); return true; },
    sendQueuedNow: async (id) => calls.push(["queued", id]),
    draft: {
      ref: { current: null }, draftRevision: () => 1,
      draftSnapshot: (text) => ({ text, fileReferences: [] }),
      clearDraftForKey: (...args) => calls.push(["clear", ...args]),
      restoreDraftForKey: (...args) => calls.push(["restore", ...args]),
    },
    ...overrides,
  });

  await makeSubmit().submit(true);
  assert.deepEqual(calls, [["queued", waiting.id]]);

  calls.length = 0;
  await makeSubmit().submit();
  assert.deepEqual(calls, []);

  calls.length = 0;
  await makeSubmit({ sendBlocked: true }).submit(true);
  assert.deepEqual(calls, []);

  calls.length = 0;
  await makeSubmit({ value: "draft text" }).submit(true);
  assert.equal(calls[0]?.[0], "clear");
  assert.equal(calls[1]?.[0], "steer");
  assert.equal(calls.some((call) => call[0] === "queued"), false);
});

test("the composer hands the session queue and Send now to the submit hook", async () => {
  const composer = await readComposerSource();
  const submitOptions =
    composer.match(/useComposerSubmit\(\{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(submitOptions.length > 0, "useComposerSubmit options not found");
  assert.match(submitOptions, /\n {4}sendQueuedNow,\n/);
  assert.match(submitOptions, /\n {4}queuedPrompts,\n/);
});
