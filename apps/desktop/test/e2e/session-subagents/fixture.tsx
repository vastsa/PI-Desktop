import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { ConversationTopbar } from "../../../src/components/ConversationTopbar";
import { WorkPanel } from "../../../src/components/workpanel/WorkPanel";
import { SessionSubagentsTab } from "../../../src/features/subagents/SessionSubagentsTab";
import { useAppStore } from "../../../src/stores/app-store";
import { switchWorkPanelSession } from "../../../src/stores/slices/work-panel-slice";
import "../../../src/styles/tokens.css";
import "../../../src/styles/base.css";
import "../../../src/styles/chrome.css";
import "../../../src/styles/chat-shell.css";
import "../../../src/styles/messages.css";
import "../../../src/styles/prose.css";
import "../../../src/styles/ui-kit.css";
import "../../../src/styles/settings.css";
import "../../../src/styles/work-panel.css";
import "../../../src/styles/session-subagents.css";

await i18n.use(initReactI18next).init({
  lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const t = (key: string, options?: Record<string, unknown>) => {
  if (!i18n.exists(key)) throw new Error(`Unresolved UI label: ${key}`);
  return String(i18n.t(key, options));
};
const checks: string[] = [];
const reads: Array<{ id: string; messageLimit: number; contentLimit: number; messageBefore?: number; messageAround?: string }> = [];
const stops: Array<{ sessionId: string; delegationIds?: string[] }> = [];
const unexpected: string[] = [];
const copied: string[] = [];
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(`${message} (phase: ${phase})`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const stamp = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
function task(n: number, id: string, agent: string, description: string, status = "completed", resume?: string): UiMessage {
  return {
    id: `task-${id}`, role: "tool", content: "", createdAt: stamp(n),
    toolName: "Task", toolCallId: `call-${id}`, toolStatus: status === "failed" ? "error" : "success",
    toolArgs: { agent, task: description, description, ...(resume ? { resume } : {}) },
    toolResult: { content: [{ type: "text", text: "REPORT-ONLY-SENTINEL" }],
      details: { delegationId: id, agent, status, modelId: `fixture/model-${id}` } },
  };
}
function step(n: number, id: string, parent: string, content: string): UiMessage {
  return { id, role: "assistant", content, createdAt: stamp(n), status: "complete",
    parentToolCallId: parent, agentName: "explorer" };
}
const a1 = task(40, "a1", "explorer", "Inspect the initial file");
const a2 = task(430, "a2", "explorer", "Follow up on owned changes", "running", "a1");
const beta = task(400, "beta", "reviewer", "Verify parallel fixture");
const failed = task(680, "failed", "tester", "Check failed fixture", "failed");
const delta = task(700, "delta", "fixer", "Work on another fixture", "running");
const old = task(0, "old", "archived", "Inspect earlier fixture");
const history: UiMessage[] = Array.from({ length: 900 }, (_, n) => ({
  id: `parent-${n}`, role: "assistant", content: `Parent row ${n}`, createdAt: stamp(n), status: "complete",
}));
history[0] = old;
history[40] = a1;
history[41] = step(41, "step-a-initial", "call-a1", "Recorded initial A step, not just a report.");
history[42] = { id: "read-a", role: "tool", content: "", createdAt: stamp(42),
  parentToolCallId: "call-a1", agentName: "explorer", toolName: "Read", toolCallId: "read-owned",
  toolStatus: "success", toolArgs: { path: "src/owned-fixture.ts" },
  toolResult: { content: [{ type: "text", text: "READ-RESULT-A: export const owned = true;" }] } };
history[400] = beta;
history[401] = step(401, "step-beta", "call-beta", "PARALLEL-B-CONTENT");
history[430] = { ...a2, toolResult: { details: { delegationId: "a2", agent: "explorer", status: "completed", modelId: "fixture/model-a2" } } };
history[431] = step(431, "step-a-resume", "call-a2", "Old persisted A snapshot");
history[680] = failed;
history[700] = delta;
let liveA = [a1, a2, step(431, "step-a-resume", "call-a2", "Live A snapshot wins")];
const sessionBTask = task(0, "session-b-delegate", "second-session", "Inspect second session");
const historyB = [sessionBTask, step(1, "step-session-b", "call-session-b-delegate", "Second session recorded step")];
const sessions = ["session-a", "session-b"].map((id) => ({ id, title: id, mode: "agent" as const,
  providerId: "fixture", modelId: "fixture", thinkingLevel: "off" as const,
  createdAt: stamp(0), updatedAt: stamp(900) }));
const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
let failDetail = true;
let failIndex = false;
let pendingStop: ReturnType<typeof deferred<unknown>> | undefined;
function result(request: typeof reads[number]) {
  const rows = request.id === "session-a" ? history : historyB;
  const around = request.messageAround === undefined ? -1 : rows.findIndex((row) => row.toolCallId === request.messageAround || row.id === request.messageAround);
  const end = around < 0 ? Math.min(rows.length, request.messageBefore ?? rows.length)
    : Math.min(rows.length, Math.max(0, around - request.messageLimit / 2) + request.messageLimit);
  const start = around < 0 ? Math.max(0, end - request.messageLimit) : Math.max(0, around - request.messageLimit / 2);
  return { session: { ...sessions.find((session) => session.id === request.id),
    messages: rows.slice(start, end), messageCount: rows.length, messageStart: start, messageEnd: end,
    hasMoreBefore: start > 0, hasMoreAfter: end < rows.length } };
}
Object.defineProperty(window, "piDesktop", { value: {
  platform: "win32", on() { return () => {}; },
  async invoke(method: string, request: typeof reads[number] & typeof stops[number]) {
    if (method === IPC.invoke.sessionGet) {
      reads.push({ ...request });
      const kind = request.contentLimit === 512 ? "index" : "detail";
      const key = `${request.id}:${kind}`;
      const pending = held.get(key);
      if (pending) { held.delete(key); return { ok: true, data: await pending.promise }; }
      if (kind === "detail" && failDetail) { failDetail = false; throw new Error("Fixture detail read failed"); }
      if (kind === "index" && failIndex) { failIndex = false; throw new Error("Fixture index read failed"); }
      return { ok: true, data: result(request) };
    }
    if (method === IPC.invoke.agentStopSubagents) {
      stops.push({ ...request });
      if (pendingStop) { const value = pendingStop; pendingStop = undefined; return { ok: true, data: await value.promise }; }
      return { ok: true, data: { stopped: [], pending: ["delta"], notFound: [] } };
    }
    unexpected.push(method);
    throw new Error(`Unexpected IPC: ${method}`);
  },
} });
Object.defineProperty(navigator, "clipboard", { value: { async writeText(value: string) { copied.push(value); } } });
useAppStore.setState({ sessions, activeSessionId: "session-a", messages: liveA,
  runningSessions: { "session-a": true, "session-b": false }, pluginViews: [],
  workPanelTabs: [], activeWorkPanelTabId: null, workPanelOpen: false, workPanelContexts: {},
  workspace: null, projectMeta: {}, workPanelWidth: 400 });
let surface: "normal" | "page" | "topbar" = "normal";
function Surface() {
  const open = useAppStore((state) => state.workPanelOpen);
  return <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
    <div style={{ flex: 1, minWidth: 0 }}><ConversationTopbar sidebarCollapsed workPanelOpen={open}
      onToggleSidebar={() => {}} onNewTask={() => {}} onOpenSearch={() => {}} /></div>
    {surface === "page" ? <SessionSubagentsTab /> : surface === "normal" && open
      ? <WorkPanel containerWidth={1200} sidebarCollapsed /> : null}
  </div>;
}
const root = createRoot(document.getElementById("root")!);
const render = () => flushSync(() => root.render(<Surface />));
render();
let phase = "initialization";
function stage(value: string) { phase = value; console.info(`SESSION_SUBAGENTS_PHASE ${Math.round(performance.now())}ms ${value}`); }
console.info("SESSION_SUBAGENTS_RENDERED");
// Yield to React/IPC tasks, not a hidden window's throttled animation clock.
// Observable conditions below have their own deadlines; there are no fixed sleeps.
const nextTask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close(); channel.port2.close(); resolve();
  };
  channel.port2.postMessage(null);
});
async function settle() { await nextTask(); await nextTask(); }
async function until(predicate: () => unknown, message: string) {
  stage(message);
  const deadline = performance.now() + 6_000;
  while (!predicate() && performance.now() < deadline) await nextTask();
  check(predicate(), `${message}: ${JSON.stringify({ entries: entries().map((node) => node.dataset.delegationId), reads, content: content().slice(0, 2_500) })}`);
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((node) => node.getAttribute("aria-label") === label);
const textButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((node) => node.textContent?.trim() === label);
async function click(node: HTMLButtonElement | undefined | null) {
  check(node && !node.disabled, "Expected an enabled button");
  stage(`click ${node!.getAttribute("aria-label") ?? node!.textContent}`);
  flushSync(() => node!.click()); await settle();
}
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-delegation-id]")];
const content = () => document.querySelector(".session-subagents")?.textContent ?? "";
function unchanged(snapshot: readonly UiMessage[]) {
  check(useAppStore.getState().messages === snapshot, "History reader replaced the main transcript");
}
function activate(id?: string) {
  stage(`activate ${id ?? "no session"}`);
  const state = useAppStore.getState();
  flushSync(() => useAppStore.setState({ ...switchWorkPanelSession(state, id), activeSessionId: id,
    messages: id === "session-b" ? historyB : liveA }));
}
async function search(value: string) {
  stage(`search ${value}`);
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${t("panel.sessionSubagents.search")}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  await settle();
}
Object.assign(window, { sessionSubagentsProbe: async () => {
  try {
    stage("probe start");
    check(t("panel.sessionSubagents.retry") === "Retry", "Retry action label is not localized");
    for (const [locale, catalog] of Object.entries(catalogs)) {
      check(typeof flattenCatalog(catalog)["panel.sessionSubagents.retry"] === "string", `Missing retry label for ${locale}`);
    }
    await click(button(t("panel.sessionSubagents.open")));
    await until(() => entries().length === 3 && !document.querySelector('[aria-busy="true"]'), "Initial directory did not load");
    await click(button(t("panel.sessionSubagents.open")));
    check(useAppStore.getState().workPanelTabs.length === 1, "Topbar opened duplicate directories");
    check(!content().includes("REPORT-ONLY-SENTINEL") && !content().includes("Recorded initial A step"), "Index retained child content or reports");
    await click(textButton(t("panel.sessionSubagents.moreAgents")));
    await until(() => entries().length === 4, "First older index page was not appended");
    await click(textButton(t("panel.sessionSubagents.moreAgents")));
    await until(() => entries().length === 5 && !textButton(t("panel.sessionSubagents.moreAgents")), "Earlier Task pages were silently truncated");
    check(entries().filter((node) => node.dataset.delegationId === "a2").length === 1, "Resume chain was duplicated");
    unchanged(liveA); checks.push("topbar, bounded older index and resumed-chain directory");

    await search("FIXTURE/MODEL-A2");
    check(entries().length === 1 && entries()[0].dataset.delegationId === "a2", "Model search failed");
    await search("nothing-matches"); check(content().includes(t("panel.sessionSubagents.noMatches")), "No-match state missing");
    await search("");
    await click(textButton(t("chat.subagentStatus.running"))); check(entries().length === 2, "Running filter lost live status");
    await click(textButton(t("chat.subagentStatus.completed"))); check(entries().length === 2, "Completed filter failed");
    await click(textButton(t("panel.sessionSubagents.issues"))); check(entries().length === 1 && entries()[0].dataset.delegationId === "failed", "Issues filter failed");
    await click(textButton(t("panel.sessionSubagents.all")));
    const panel = document.querySelector(".session-subagents")!;
    await document.fonts.ready;
    await until(() => panel.scrollWidth <= panel.clientWidth + 1,
      "Directory overflowed its compact panel after layout settled");
    const compactHeader = panel.querySelector<HTMLElement>(".session-subagents-header");
    check(panel.scrollWidth <= panel.clientWidth + 1, `Directory overflowed its compact panel: ${panel.scrollWidth}/${panel.clientWidth}; header ${compactHeader?.scrollWidth}/${compactHeader?.clientWidth}`);
    checks.push("search, filters, empty result and compact layout");

    await click(button(t("panel.sessionSubagents.view", { name: "Follow up on owned changes" })));
    await until(() => document.querySelector('[role="alert"]'), "Detail error state missing");
    await click(textButton(t("panel.sessionSubagents.retry")));
    await until(() => content().includes("Recorded initial A step"), "Recorded child steps were not loaded");
    check(content().includes("Inspect the initial file") && content().includes("Follow up on owned changes"), "Resume prompts were lost");
    const tool = document.querySelector('[data-message-id="read-a"] button[aria-expanded]') as HTMLButtonElement;
    await click(tool);
    await until(() => document.querySelector('[data-message-id="read-a"]')?.textContent?.includes("READ-RESULT-A"), "Recorded tool result could not be inspected");
    await click(textButton(t("panel.sessionSubagents.moreActivity")));
    await until(() => content().includes("Live A snapshot wins"), "Resumed child rows were not merged");
    check(!content().includes("Old persisted A snapshot") && !content().includes("PARALLEL-B-CONTENT"), "Live precedence or parallel ownership failed");
    liveA = liveA.map((row) => row.id === "step-a-resume" ? { ...row, content: "New streamed A snapshot" } : row);
    flushSync(() => useAppStore.setState({ messages: liveA }));
    await until(() => content().includes("New streamed A snapshot"), "Detail did not follow live transcript updates");
    check(!content().includes("Live A snapshot wins"), "An older live snapshot remained after update");
    unchanged(liveA); checks.push("real store-driven live content updates");
    await click(button(t("panel.sessionSubagents.copyId")));
    check(copied.join() === "a2", "Copied an obsolete chain ID");
    check(document.querySelector<HTMLTextAreaElement>('[data-testid="subagent-message-form"] textarea'), "Detail is missing its direct message draft");
    unchanged(liveA); checks.push("detail retry, recorded text/tools, pagination, live precedence and copy ID");
    await click(button(t("panel.sessionSubagents.back")));

    const creating: UiMessage = { ...task(901, "creating", "pending-agent", "Prepare fixture", "running"),
      toolStatus: "running", toolResult: undefined };
    history.push(creating); liveA = [...liveA, creating];
    flushSync(() => useAppStore.setState({ messages: liveA }));
    await until(() => entries().length === 6, "Creating task was not listed");
    check(!button(t("chat.stopSubagentNamed", { name: "pending-agent" })), "Creating entry sent a call ID to Stop");
    await click(button(t("panel.sessionSubagents.view", { name: "Prepare fixture" })));
    await until(() => content().includes(t("chat.subagentCreating")), "Creating state was not visible");
    const unnamedStop = t("chat.stopSubagentNamed", { name: t("chat.subagentUnnamed") });
    check(button(t("panel.sessionSubagents.copyId"))?.disabled && !button(unnamedStop), "Creating detail exposed an invalid ID operation");
    const created: UiMessage = { ...creating, toolStatus: "success", toolResult: { details: {
      delegationId: "created-handle", status: "running", agent: "pending-agent",
    } } };
    history[history.length - 1] = created;
    liveA = liveA.map((row) => row.id === creating.id ? created : row);
    flushSync(() => useAppStore.setState({ messages: liveA }));
    await until(() => button(t("panel.sessionSubagents.copyId"))?.disabled === false
      && button(t("chat.stopSubagentNamed", { name: "pending-agent" })), "Stable handle lost selection or did not enable operations");
    check(stops.length === 0 && copied.join() === "a2", "Creating task performed an invalid operation");
    await click(button(t("panel.sessionSubagents.back")));
    history.pop(); liveA = liveA.filter((row) => row.id !== creating.id);
    flushSync(() => useAppStore.setState({ messages: liveA }));
    await until(() => entries().length === 5, "Fixture creation cleanup did not settle");
    unchanged(liveA); checks.push("creating handle, guarded operations and stable detail selection");

    const stopDone = deferred<unknown>(); pendingStop = stopDone;
    const single = button(t("chat.stopSubagentNamed", { name: "explorer" }))!;
    flushSync(() => single.click());
    await until(() => single.disabled, "Stop did not disable duplicate requests");
    single.click(); check(stops.length === 1, "Duplicate individual stop was sent");
    stopDone.resolve({ stopped: ["a2"], pending: [], notFound: [] }); await settle();
    check(JSON.stringify(stops[0]) === JSON.stringify({ sessionId: "session-a", delegationIds: ["a2"] }), "Stop selected the wrong session/chain");
    liveA = liveA.map((row) => row.id === a2.id ? { ...row, toolResult: { details: {
      delegationId: "a2", agent: "explorer", status: "stopped", modelId: "fixture/model-a2",
    } } } : row);
    flushSync(() => useAppStore.setState({ messages: liveA }));
    await until(() => entries().find((node) => node.dataset.delegationId === "a2")?.textContent?.includes(t("chat.subagentStatus.stopped")), "Confirmed stop did not update the directory");
    await click(button(t("chat.stopAllSubagents")));
    check(stops.length === 2 && stops[1].sessionId === "session-a" && !stops[1].delegationIds, "Stop all escaped the session boundary");
    check(useAppStore.getState().runningSessions["session-a"], "Stopping delegates stopped the parent turn");
    unchanged(liveA); checks.push("individual/all stop, duplicate guard and parent-turn preservation");

    failIndex = true;
    await click(button(t("panel.sessionSubagents.refresh")));
    await until(() => document.querySelector('[role="alert"]'), "Index failure was hidden");
    await click(textButton(t("panel.sessionSubagents.retry")));
    await until(() => !document.querySelector('[role="alert"]') && entries().length === 3, "Index retry failed");
    await click(button(t("panel.new.open")));
    await click(document.querySelector<HTMLButtonElement>('[data-work-panel-launcher-item="subagents"]'));
    check(useAppStore.getState().workPanelTabs.length === 1, "Launcher did not reuse the directory");
    checks.push("index retry and real work-panel launcher");

    const staleDetail = deferred<unknown>(); held.set("session-a:detail", staleDetail);
    await click(button(t("panel.sessionSubagents.view", { name: "Follow up on owned changes" })));
    await until(() => content().includes(t("common.loading")), "Held detail was not pending");
    activate("session-b"); await click(button(t("panel.sessionSubagents.open")));
    await until(() => entries().length === 1, "Second session directory did not load");
    const oldRequest = [...reads].reverse().find((request) => request.id === "session-a" && request.contentLimit === 8_000)!;
    staleDetail.resolve(result(oldRequest)); await settle();
    check(!content().includes("Recorded initial A step") && content().includes("Inspect second session"), "Late detail crossed sessions");
    unchanged(historyB);
    const staleIndex = deferred<unknown>(); held.set("session-b:index", staleIndex);
    await click(button(t("panel.sessionSubagents.refresh")));
    const close = button(t("panel.closeTab", { name: t("panel.tabs.subagents") }));
    await click(close); check(!document.querySelector(".session-subagents"), "Closing the tab left its reader mounted");
    const oldPage = result(reads[reads.length - 1]);
    oldPage.session.messages = [task(0, "stale-index", "stale", "STALE-INDEX-CONTENT")];
    staleIndex.resolve(oldPage); await settle();
    await click(button(t("panel.sessionSubagents.open")));
    await until(() => entries().length === 1, "Reopened directory did not load");
    check(!content().includes("STALE-INDEX-CONTENT"), "Disposed index committed after reopen");
    unchanged(historyB); checks.push("session switch, tab close/reopen and stale result isolation");

    surface = "page"; activate(undefined); render(); await settle();
    const readCount = reads.length;
    check(!button(t("panel.sessionSubagents.open")) && content().includes(t("panel.sessionSubagents.noSession")) && entries().length === 0, "No-session surface reused old messages");
    check(button(t("panel.sessionSubagents.refresh"))?.disabled && reads.length === readCount, "No-session reader issued requests");
    surface = "topbar";
    flushSync(() => useAppStore.setState({ activeSessionId: "remote:fixture", sessions: [
      ...sessions, { ...sessions[0], id: "remote:fixture", source: "remote" },
    ] })); render(); await settle();
    check(!button(t("panel.sessionSubagents.open")), "Remote topbar exposed a local operation entry");
    check(unexpected.length === 0, `Unexpected IPC: ${unexpected.join(", ")}`);
    check(reads.every((request) => request.messageLimit === 256 && [512, 8_000].includes(request.contentLimit)), "History read was unbounded");
    checks.push("no-session and remote entry boundaries");
    return { passed: true, checks, reads: reads.length, stops, copied };
  } finally { flushSync(() => root.unmount()); }
} });
