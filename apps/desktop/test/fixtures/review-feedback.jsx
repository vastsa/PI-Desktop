import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ReviewTab } from "../../src/components/workpanel/ReviewTab";
import { ReviewChangeCard } from "../../src/components/ReviewChangeCard";
import { Composer } from "../../src/components/Composer";
import { useAppStore } from "../../src/stores/app-store";

const session = (id) => ({ id, title: `Feedback ${id}`, mode: "agent", permissionMode: "ask", providerId: "fixture", modelId: "fixture-model", thinkingLevel: "off" });
const message = { id: "tool-a", role: "tool", content: "Updated src/recover.ts", toolName: "Edit", toolStatus: "success", toolResult: { details: {
  root: "workspace", review: { version: 1, snapshotId: "snapshot-a", messageId: "tool-a", path: "src/recover.ts", operation: "edit", status: "modified", state: "active", additions: 2, deletions: 1, reversible: true,
    hunks: [{ header: "@@ -8,2 +8,3 @@", lines: [{ type: "context", text: "try {" }, { type: "del", text: "  recover(error);" }, { type: "add", text: "  return null;" }, { type: "add", text: "}" }] }] },
} } };
window.piDesktop = { platform: "win32", on() { return () => {}; }, async invoke(channel, ...args) {
  if (channel === IPC.invoke.fsResolveRef) return { ok: true, data: { match: { root: "workspace", relativePath: "src/recover.ts", absolutePath: "/fixture/src/recover.ts" } } };
  if (channel === IPC.invoke.agentPrompt) {
    window.reviewFixture.requests.push(args[0]);
    if (window.reviewFixture.defer) await new Promise((resolve) => { window.reviewFixture.release = resolve; });
    if (window.reviewFixture.reject) return { ok: false, error: { code: "TEST_REJECT", message: "Test send rejected" } };
  }
  if (channel === IPC.invoke.agentQueuePush) {
    window.reviewFixture.queued.push(args[0]);
    return { ok: true, data: { id: "queue-a", sessionId: args[0].sessionId, content: args[0].content, createdAt: new Date().toISOString() } };
  }
  if (channel === IPC.invoke.agentQueueList) return { ok: true, data: { entries: window.reviewFixture.queued.map((row) => ({ ...row, id: "queue-a", createdAt: new Date().toISOString() })) } };
  if (channel === IPC.invoke.agentQueueRemove) window.reviewFixture.queued = [];
  if (channel === IPC.invoke.workspaceReviewRollback) {
    window.reviewFixture.rollbacks.push(args[0]);
    return { ok: true, data: { status: "conflict", snapshotId: "snapshot-a" } };
  }
  return { ok: true, data: { entries: [], commands: [], sessions: [session("a"),session("b")] } };
} };
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, { translation: flattenCatalog(catalogs[locale]) }])), interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
useAppStore.setState({ ready: true, page: "chat", activeSessionId: "a", workspace: { path: "/fixture", name: "Review fixture" },
  sessions: [session("a"),session("b")], messages: [message], providers: [{ id: "fixture", name: "Fixture", enabled: true, authKind: "none", type: "openai_compatible", models: [{ id: "fixture-model" }] }],
});
const render = () => flushSync(() => root.render(<main style={{ maxWidth: 880, margin: "24px auto", padding: 16 }}>
  <h1>Review feedback</h1><div data-review-transcript><ReviewChangeCard message={message} /></div><ReviewTab /><Composer />
</main>));
window.reviewFixture = {
  requests: [], queued: [], rollbacks: [], reject: false, defer: false, release: null,
  switchSession(id, workspace = "/fixture") { flushSync(() => useAppStore.setState({ activeSessionId: id, workspace: { path: workspace }, messages: id === "a" ? [message] : [], isRunning: false, runningSessions: {} })); },
  running(value) { flushSync(() => useAppStore.setState({ isRunning: value, runningSessions: { a: value } })); },
  editQueue() { useAppStore.getState().editQueuedPrompt("queue-a"); },
  longChange() {
    const next = structuredClone(message);
    next.toolResult.details.review.snapshotId = "long-snapshot";
    next.toolResult.details.review.hunks = [{ header: "@@ -1,60 +1,61 @@", lines: [...Array.from({length:60},(_,i)=>({type:"context",text:`const value${i} = ${i};`})), {type:"add",text:"return value0;"}] }];
    flushSync(() => useAppStore.setState({ messages: [next] }));
  },
  remount() { flushSync(() => root.render(null)); render(); },
  async locale(locale, theme) { await i18n.changeLanguage(locale); document.documentElement.dataset.theme = theme; },
  state() { return { queued: useAppStore.getState().queuedPrompts, toasts: useAppStore.getState().toasts, fileRequest: useAppStore.getState().workPanelFileRequest, activeTab: useAppStore.getState().activeWorkPanelTabId }; },
};
render();
