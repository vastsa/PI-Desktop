import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";

test("pending queue actions stay locked until admission succeeds", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const { ComposerStatus } = await server.ssrLoadModule("/src/features/chat/composer/ComposerStatus.tsx");
    for (const action of ["removeQueuedPrompt", "editQueuedPrompt"]) {
      await t.test(action, async () => {
        let resolvePush;
        const admission = new Promise((resolve) => { resolvePush = resolve; });
        let entries = [];
        const removed = [];
        globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
          if (channel === IPC.invoke.agentQueuePush) {
            await admission;
            const entry = { ...payload, id: "durable-turn", createdAt: "2026-09-21T00:00:00Z" };
            entries = [entry];
            return { ok: true, data: entry };
          }
          if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
          if (channel === IPC.invoke.agentQueueRemove) {
            removed.push(payload.turnId);
            entries = entries.filter((entry) => entry.id !== payload.turnId);
            return { ok: true, data: {} };
          }
          throw new Error(`Unexpected IPC: ${channel}`);
        } } };
        let state = { activeSessionId: "session-a", queuedPrompts: {}, showToast: assert.fail };
        const slice = createQueueSlice({
          get: () => state,
          set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
          promptAttachmentsFromDraft: () => [],
        });
        Object.assign(state, slice);
        const draft = { text: "Please review this file", fileReferences: [{ path: "/test/example.ts", name: "example.ts" }] };
        const saving = slice.enqueuePrompt(draft.text, draft);
        const pending = state.queuedPrompts["session-a"][0];
        const renderButtons = () => renderToStaticMarkup(createElement(ComposerStatus, {
          t: (key) => key, queuedPrompts: state.queuedPrompts["session-a"] ?? [],
          ...slice, approvalPending: false, enhancementError: null, droppedDirectories: [],
        })).match(/<button\b[^>]*>/g) ?? [];
        const pendingButtons = renderButtons();
        assert.equal(pendingButtons.length, 5);
        assert.ok(pendingButtons.every((button) => / disabled=""/.test(button)), "all pending row actions must be disabled");
        assert.ok(pendingButtons.every((button) => /aria-label="[^"]*common.saving/.test(button)), "every pending action must explain that admission is still saving");
        const pendingMarkup = renderToStaticMarkup(createElement(ComposerStatus, {
          t: (key) => key, queuedPrompts: [pending], ...slice,
          approvalPending: false, enhancementError: null, droppedDirectories: [],
        }));
        assert.match(pendingMarkup, /class="composer-queued-prompt-send-now"[^>]*>common.saving<\/button>/);
        slice[action](pending.id);
        assert.deepEqual(state.queuedPrompts["session-a"], [pending], "pending row must not appear deleted");
        assert.equal(state.composerPrefill, undefined, "pending edit must not restore a second draft");
        assert.deepEqual(removed, []);
        resolvePush();
        assert.equal(await saving, true);
        await slice.refreshQueuedPrompts("session-a");
        assert.ok(renderButtons().every((button) => !/ disabled=""/.test(button)), "acknowledged row actions unlock");
        assert.ok(renderButtons().every((button) => !button.includes("common.saving")), "saving labels clear after acknowledgement");
        slice[action]("durable-turn");
        await slice.refreshQueuedPrompts("session-a");
        assert.deepEqual(removed, ["durable-turn"]);
        assert.deepEqual(entries, []);
        assert.deepEqual(state.queuedPrompts["session-a"] ?? [], []);
        if (action === "editQueuedPrompt") {
          assert.deepEqual(state.composerPrefill, { sessionId: "session-a", ...draft });
        }
      });
    }
    await t.test("failed admission clears the pending row and permits another submission", async () => {
      let rejectPush;
      const admission = new Promise((_, reject) => { rejectPush = reject; });
      const errors = [];
      let entries = [];
      globalThis.window = { piDesktop: { invoke: async (channel, payload) => {
        if (channel === IPC.invoke.agentQueuePush) {
          if (!errors.length) await admission;
          const entry = { ...payload, id: "retried-turn", createdAt: "2026-09-21T00:00:00Z" };
          entries = [entry];
          return { ok: true, data: entry };
        }
        if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries } };
        throw new Error(`Unexpected IPC: ${channel}`);
      } } };
      let state = { activeSessionId: "session-a", queuedPrompts: {}, showToast: (message) => errors.push(message) };
      const slice = createQueueSlice({
        get: () => state,
        set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
        promptAttachmentsFromDraft: () => [],
      });
      Object.assign(state, slice);
      const saving = slice.enqueuePrompt("Retry this prompt");
      assert.equal(state.queuedPrompts["session-a"].length, 1);
      rejectPush(new Error("host RPC timeout: session.queuePush"));
      assert.equal(await saving, false, "composer must receive rejection so it can restore the draft");
      assert.deepEqual(state.queuedPrompts["session-a"] ?? [], []);
      assert.deepEqual(errors, ["host RPC timeout: session.queuePush"]);
      assert.equal(await slice.enqueuePrompt("Retry this prompt"), true);
      await slice.refreshQueuedPrompts("session-a");
      assert.equal(state.queuedPrompts["session-a"][0].id, "retried-turn");
    });
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
});
