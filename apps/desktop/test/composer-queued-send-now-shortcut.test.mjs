import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
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

test("the steer shortcut sends the first waiting follow-up when the composer is empty", async () => {
  const submitHook = await readComposerModule("hooks/useComposerSubmit.ts");

  const emptyDraftBranch =
    submitHook.match(
      /if \(!serializedContent\) \{[\s\S]*?\n {4}\}\n/,
    )?.[0] ?? "";
  assert.ok(emptyDraftBranch.length > 0, "empty draft branch not found");
  // Steering only: a plain Enter on an empty composer stays inert, and a
  // blocked composer must not promote anything.
  assert.match(
    emptyDraftBranch,
    /steering && !sendBlocked \? nextSendableQueuedPrompt\(queuedPrompts\) : undefined/,
  );
  assert.match(emptyDraftBranch, /if \(waiting\) await sendQueuedNow\(waiting\.id\);/);
  assert.doesNotMatch(emptyDraftBranch, /sendPrompt\(/);
});

test("the composer hands the session queue and Send now to the submit hook", async () => {
  const composer = await readComposerSource();
  const submitOptions =
    composer.match(/useComposerSubmit\(\{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(submitOptions.length > 0, "useComposerSubmit options not found");
  assert.match(submitOptions, /\n {4}sendQueuedNow,\n/);
  assert.match(submitOptions, /\n {4}queuedPrompts,\n/);
});
