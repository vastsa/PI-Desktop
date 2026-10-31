import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("a steering response keeps the earlier delegation card live until parent settlement", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TranscriptHistory } = await vite.ssrLoadModule("/src/features/chat/transcript/AssistantTurn.tsx");
    const { buildTranscriptEntries } = await vite.ssrLoadModule("/src/lib/assistant-turns.ts");
    const { collectLiveDelegationEntries } = await vite.ssrLoadModule("/src/lib/live-delegation-entries.ts");
    const { SlotSessionProvider } = await vite.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const message = (id, role, content, extra = {}) => ({
      id, role, content, createdAt: "2026-10-13T00:00:00.000Z", ...extra,
    });
    const task = message("task", "tool", "", {
      toolName: "Task", toolCallId: "task", toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Investigate" },
      toolResult: { details: { delegationId: "delegate", status: "running", startedAt: Date.parse("2026-10-13T00:00:00Z") } },
    });
    const messages = [message("user", "user", "Start a delegate."), task,
      message("wait", "tool", "", { toolName: "TaskWait", toolCallId: "wait", toolStatus: "success",
        toolResult: { details: { status: "interrupted", delegations: [{ delegationId: "delegate", status: "running" }] } } }),
      message("steer", "user", "Correct the plan.", { steering: true }),
      message("reply", "assistant", "Correction handled."),
    ];
    const { entries } = buildTranscriptEntries(messages);
    const history = entries.slice(0, -1);
    const render = (liveDelegations) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(SlotSessionProvider, { sessionId: "fixture" },
        createElement(TranscriptHistory, { entries: history, isRunning: true, liveDelegations }))));
    const live = render(collectLiveDelegationEntries(history, entries.at(-1), true));
    assert.match(live, /Subagent working/);
    assert.match(live, /Stop explorer/);
    assert.doesNotMatch(live, /Subagent finished with warnings/);
    const settled = render(collectLiveDelegationEntries(history, entries.at(-1), false));
    assert.doesNotMatch(settled, /Subagent working/);
    assert.doesNotMatch(settled, /Stop explorer/);
    const beforeReply = entries.slice(0, -1);
    assert.equal(collectLiveDelegationEntries(beforeReply.slice(0, -1), beforeReply.at(-1), true).has("task"), true);
    const nextUser = { kind: "message", message: message("next", "user", "Next task.") };
    assert.equal(collectLiveDelegationEntries(entries, nextUser, true).has("task"), false);
    assert.equal(collectLiveDelegationEntries(entries, { kind: "message", message: message("system", "system", "Restart") }, true).has("task"), false);
    const compaction = { kind: "compaction", mark: { id: "checkpoint" } };
    assert.equal(collectLiveDelegationEntries([...history, compaction], entries.at(-1), true).has("task"), true);
    const completedTask = { ...task, toolResult: { details: { delegationId: "delegate", status: "completed" } } };
    const completeEntries = buildTranscriptEntries(messages.map(m => m.id === task.id ? completedTask : m)).entries;
    const completeHistory = completeEntries.slice(0, -1);
    const completedHtml = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(SlotSessionProvider, { sessionId: "fixture" },
        createElement(TranscriptHistory, { entries: completeHistory, isRunning: true,
          liveDelegations: collectLiveDelegationEntries(completeHistory, completeEntries.at(-1), true) }))));
    assert.match(completedHtml, /Subagent completed/);
    assert.doesNotMatch(completedHtml, /Stop explorer/);
  } finally { await vite.close(); }
});
