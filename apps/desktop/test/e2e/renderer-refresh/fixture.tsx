import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, type SessionSummary } from "@pi-desktop/shared";
import { useAppStore } from "../../../src/stores/app-store";
import { useComposerDraft } from "../../../src/features/chat/composer/hooks/useComposerDraft";
import { readComposerDraft, resetComposerDraftCache, writeComposerDraft } from "../../../src/lib/composer-draft-cache";
import { readSubagentControlDraft, restoreSubagentControlDrafts, writeSubagentControlDraft,
  prepareSubagentControlOperation } from "../../../src/features/subagents/control-drafts";
import { RendererRefreshButton } from "../../../src/features/app/RendererRefreshButton";
import { restoreRendererRefreshDrafts, restoreRendererRefreshView } from "../../../src/features/app/renderer-refresh";
import { RENDERER_REFRESH_KEY } from "../../../src/features/app/renderer-refresh-checkpoint";
import "../../../src/styles/tokens.css";
import "../../../src/styles/base.css";
import "../../../src/styles/ui-kit.css";
import "../../../src/styles/composer.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const sessions: SessionSummary[] = ["session-a", "session-b"].map((id) => ({ id, title: id, mode: "agent",
  createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" }));
const calls: string[] = [];
let releaseRead: (() => void) | undefined;
let holdRead: Promise<void> | undefined;
Object.assign(window, { piDesktop: { platform: "win32",
  invoke: async (method: string, params?: { id?: string }) => {
    calls.push(method);
    if (method === IPC.invoke.sessionGet) {
      if (holdRead) { const wait = holdRead; holdRead = undefined; await wait; }
      return { ok: true, data: { session: { ...sessions.find((session) => session.id === params?.id),
        messages: [], messageStart: 0, hasMoreBefore: false, hasMoreAfter: false } } };
    }
    return { ok: true, data: null };
  }, on: () => () => {}, send: () => {} } });
const noop = () => {};
let reloads = 0;
let phase = "initialization";
const check = (value: unknown, message: string) => { if (!value) throw new Error(`${message} (${phase})`); };
const task = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
async function settle() { await task(); await task(); }
async function until(predicate: () => unknown, message: string) {
  phase = message; const deadline = performance.now() + 6_000;
  while (!predicate() && performance.now() < deadline) await task();
  check(predicate(), `${message}: ${document.body.textContent?.slice(0, 1_000)}`);
}
function Editor() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const draft = useComposerDraft({ variant: "docked", activeSessionId: sessionId,
    workspacePath: "fixture-workspace", sessions, composerPrefill: null, clearComposerPrefill: noop,
    t, invalidateComposerTransforms: noop, inputBlocked: false });
  useLayoutEffect(() => { if (draft.ref.current) draft.paintCurrentDraft(draft.ref.current, draft.value); }, [draft.value]);
  return <><div ref={draft.ref} contentEditable suppressContentEditableWarning role="textbox" aria-label="Fixture draft"
    onInput={draft.commitEditorDom} />
    <RendererRefreshButton reload={() => { reloads += 1; }} /></>;
}
const container = document.getElementById("root")!;
let root = createRoot(container);
const initialState = () => ({ ready: true, sessions, page: "chat" as const, activeSessionId: "session-a",
  messages: [], runningSessions: { "session-a": true }, workPanelOpen: true,
  workPanelTabs: [{ id: "subagents", kind: "subagents" as const }], activeWorkPanelTabId: "subagents",
  workPanelContexts: {}, workPanelFileRequest: null });
useAppStore.setState(initialState());
writeComposerDraft("session-a", { text: "[fixture-image]", fileReferences: [{ path: "attachments/fixture-image",
  name: "fixture.png", kind: "image", mimeType: "image/png", token: "[fixture-image]" }] }, "fixture-workspace");
writeComposerDraft("session-b", { text: "OTHER-SESSION-DRAFT", fileReferences: [] });
writeComposerDraft("__home__", { text: "HOME-DRAFT", fileReferences: [] });
writeComposerDraft("deleted-session", { text: "DELETED-DRAFT", fileReferences: [] });
const address = { sessionId: "session-a", delegationId: "fixture-delegate" };
writeSubagentControlDraft(address, { text: "UNSENT-DIRECTION", agent: "explorer", model: "fixture-provider:model" });
const operationId = prepareSubagentControlOperation(address, "fixture-delegate").operationId;
root.render(<Editor />);
Object.assign(window, { runRendererRefreshProbe: async () => {
  const checks: string[] = [];
  await until(() => document.querySelector<HTMLElement>('[role="textbox"]')?.textContent, "draft mounted");
  const editor = document.querySelector<HTMLElement>('[role="textbox"]')!;
  editor.focus(); editor.append(document.createTextNode(" UNSENT-DOM-SENTINEL"));
  const button = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("app.refreshInterface")}"]`)!;
  const nativeSet = Storage.prototype.setItem;
  try {
    Storage.prototype.setItem = function (key, value) {
      if (key === RENDERER_REFRESH_KEY) throw new DOMException("Fixture quota", "QuotaExceededError");
      nativeSet.call(this, key, value);
    };
    flushSync(() => button().click()); await settle();
    check(reloads === 0 && editor.textContent?.includes("UNSENT-DOM-SENTINEL") && !button().disabled,
      "A failed checkpoint refreshed or lost the live editor");
    check(useAppStore.getState().toasts.some((toast) => toast.message === i18n.t("app.refreshFailed")), "Save failure was not visible");
  } finally { Storage.prototype.setItem = nativeSet; }
  checks.push("save failure keeps live input and exposes a retryable error");
  flushSync(() => { button().click(); button().click(); }); await settle();
  check(reloads === 1, "Refresh was duplicated");
  const checkpoint = sessionStorage.getItem(RENDERER_REFRESH_KEY)!;
  check(checkpoint.includes("UNSENT-DOM-SENTINEL") && checkpoint.includes(operationId), "Live DOM or dedup identity was not captured");
  check(!/runningSessions|messages|credentials/.test(checkpoint), "Runtime or credentials leaked into the checkpoint");
  checks.push("explicit refresh captures live DOM, other drafts and operation identity once");
  flushSync(() => root.unmount()); resetComposerDraftCache(); restoreSubagentControlDrafts([]);
  useAppStore.setState({ ...initialState(), activeSessionId: "session-b", workPanelOpen: false,
    workPanelTabs: [], activeWorkPanelTabId: null });
  restoreRendererRefreshDrafts(); await restoreRendererRefreshView();
  check(useAppStore.getState().activeSessionId === "session-a" && useAppStore.getState().activeWorkPanelTabId === "subagents"
    && useAppStore.getState().workPanelOpen, "Session or work panel was not restored");
  check(readComposerDraft("session-a")?.text.includes("UNSENT-DOM-SENTINEL")
    && readComposerDraft("session-a")?.fileReferences[0]?.path === "attachments/fixture-image", "Draft text or image ownership was lost");
  check(readComposerDraft("session-b")?.text === "OTHER-SESSION-DRAFT" && readComposerDraft("__home__")?.text === "HOME-DRAFT", "Other drafts were lost");
  check(readSubagentControlDraft(address).operationId === operationId, "Uncertain retry identity changed");
  check(!readComposerDraft("deleted-session") && !sessionStorage.getItem(RENDERER_REFRESH_KEY), "Deleted draft or consumed checkpoint lingered");
  checks.push("restore recovers session, panel, attachments and scoped drafts without executing");
  root = createRoot(container); flushSync(() => root.render(<Editor />)); await settle();
  check(document.querySelector<HTMLElement>('[role="textbox"]')?.textContent?.includes("UNSENT-DOM-SENTINEL"), "Restored draft did not reach the visible editor");
  flushSync(() => root.unmount());
  const saved = JSON.parse(checkpoint); saved.page = "chat"; sessionStorage.setItem(RENDERER_REFRESH_KEY, JSON.stringify(saved));
  useAppStore.setState({ ...initialState(), activeSessionId: "session-b", workPanelOpen: false, workPanelTabs: [], activeWorkPanelTabId: null });
  holdRead = new Promise((resolve) => { releaseRead = resolve; });
  restoreRendererRefreshDrafts(); const restoring = restoreRendererRefreshView();
  await until(() => calls.filter((method) => method === IPC.invoke.sessionGet).length >= 2, "restore owns an asynchronous read");
  useAppStore.getState().setPage("settings"); releaseRead!(); await restoring;
  check(useAppStore.getState().page === "settings" && !useAppStore.getState().workPanelOpen, "Late restoration overwrote user navigation");
  checks.push("user navigation wins over a stale restore");
  sessionStorage.setItem(RENDERER_REFRESH_KEY, "broken checkpoint"); restoreRendererRefreshDrafts();
  check(!sessionStorage.getItem(RENDERER_REFRESH_KEY), "Corrupt checkpoint was not discarded");
  resetComposerDraftCache(); restoreSubagentControlDrafts([]); restoreRendererRefreshDrafts();
  check(!readComposerDraft("session-a"), "An ordinary reload restored an already-consumed checkpoint");
  checks.push("invalid and ordinary reload paths do not replay a checkpoint");
  const forbidden = [IPC.invoke.agentPrompt, IPC.invoke.agentControlSubagent, IPC.invoke.agentStopSubagents];
  check(!calls.some((method) => forbidden.includes(method)), "Refresh executed or stopped an agent");
  check(useAppStore.getState().runningSessions["session-a"] === true, "Refresh rewrote authoritative running state");
  checks.push("refresh leaves agents and runtime truth alone");
  return { checks, reloads };
} });

Object.assign(window, { runRendererRefreshRetryProbe: async () => {
  await until(() => document.querySelector("button"), "retry fixture mounted");
  await settle();
  const nativeSet = window.setTimeout;
  const nativeClear = window.clearTimeout;
  const timers = new Map<number, () => void>();
  let timerId = 1_000_000;
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 10_000 && typeof handler === "function") {
      const id = ++timerId;
      timers.set(id, () => handler(...args));
      return id;
    }
    return nativeSet(handler, delay, ...args);
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (id !== undefined && timers.delete(id)) return;
    nativeClear(id);
  };
  const button = () => document.querySelector<HTMLButtonElement>("button")!;
  try {
    flushSync(() => button().click()); await settle();
    check(reloads === 1 && button().disabled && timers.size === 1, "Refresh did not latch with a recovery deadline");
    const expire = [...timers.values()][0]!;
    flushSync(expire); await settle();
    check(!button().disabled && timers.size === 0, "Cancelled reload left the button permanently disabled");
    check(!sessionStorage.getItem(RENDERER_REFRESH_KEY), "Cancelled reload left a stale checkpoint");
    check(readComposerDraft("session-a")?.text === "[fixture-image]", "Cancelled reload lost the draft");
    check(useAppStore.getState().toasts.some((toast) => toast.message === i18n.t("app.refreshFailed")), "Cancelled reload did not expose failure");
    flushSync(() => button().click()); await settle();
    check(reloads === 2 && timers.size === 1, "Cancelled reload cannot be retried");
    flushSync(() => root.unmount());
    check(timers.size === 0, "Refresh deadline outlived its component");
    return { reloads, retryable: true, preserved: true };
  } finally { window.setTimeout = nativeSet; window.clearTimeout = nativeClear; }
} });
