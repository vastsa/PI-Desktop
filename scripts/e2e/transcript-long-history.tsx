import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AgentEventEnvelope, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const createdAt = "2026-09-01T00:00:00.000Z";
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Long history: ${label}`);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string, diagnostic?: () => unknown) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Long history did not settle: ${label}${diagnostic ? ` ${JSON.stringify(diagnostic())}` : ""}`);
}

type FixtureSession = { summary: SessionSummary; messages: UiMessage[]; reads: { count: number }; tail: string };
const row = (id: string, role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id, role, content, createdAt, status: "complete", ...extra,
});
const tool = (id: string): UiMessage => row(id, "tool", "Synthetic result", {
  toolName: "Bash", toolCallId: id, toolStatus: "success",
  toolArgs: { command: `printf ${id}` }, toolResult: { details: { stdout: "Synthetic result", exitCode: 0 } },
});
function session(id: string, messages: UiMessage[]): FixtureSession {
  const reads = { count: 0 };
  // Count actual body access, including projection, Composer and mounted rows.
  // Keep each row immutable: this is observation, not a mocked render/projector.
  for (const message of messages.filter((message) => message.status !== "streaming")) {
    const content = message.content;
    Object.defineProperty(message, "content", { enumerable: true, get() { reads.count++; return content; } });
    Object.freeze(message);
  }
  return { messages, reads, tail: messages.at(-1)!.id, summary: {
    id, title: `Synthetic ${id}`, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
    providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt, messageCount: messages.length,
  } };
}
function history(count: number): FixtureSession {
  const id = `long-history-${count}`;
  const messages = Array.from({ length: count - 4 }, (_, index) => row(
    `${id}-${index}`, index % 2 ? "assistant" : "user", `${id} row ${index}. ${"Synthetic history. ".repeat(16)}`,
  ));
  messages.push(row(`${id}-user`, "user", `Inspect ${count} loaded rows`), tool(`${id}-tool`),
    row(`${id}-progress`, "assistant", `${id} unchanged progress`),
    row(`${id}-tail`, "assistant", `${id} live`, { status: "streaming", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }));
  return session(id, messages);
}
function giant(group: boolean): FixtureSession {
  const id = group ? "long-activity-group" : "long-single-turn";
  const messages = [row(`${id}-user`, "user", id)];
  for (let index = 0; index < 256; index++) {
    if (group || index % 8 === 0) messages.push(tool(`${id}-tool-${index}`));
    if (!group) messages.push(row(`${id}-fragment-${index}`, "assistant", `Fragment ${index}. ${"Synthetic body. ".repeat(96)}`));
  }
  if (group) {
    messages[129] = { ...messages[129], toolStatus: "running", status: "streaming" };
    messages.push(row(`${id}-thinking`, "assistant", "", { thinking: "Inspecting the final tool", status: "streaming" }));
  } else {
    messages[1] = { ...messages[1], toolName: "Task", toolArgs: { agent: "explorer", task: "Synthetic child" },
      toolResult: { details: { delegationId: `${id}-delegate`, status: "running", startedAt: Date.now() } } };
    messages.splice(2, 0, row(`${id}-child`, "assistant", "Child initial", {
      parentToolCallId: messages[1].toolCallId, agentName: "explorer", status: "streaming",
    }));
  }
  messages.push(row(`${id}-tail`, "assistant", `${id} live`, {
    status: "streaming", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  }));
  return session(id, messages);
}

function Surface({ sessions, errors }: { sessions: FixtureSession[]; errors: unknown[] }) {
  const id = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) => state.messages);
  const running = useAppStore((state) => state.isRunning);
  const tab = useAppStore((state) => state.activeWorkPanelTabId);
  return <>
    <nav aria-label="Synthetic session navigation">
      {sessions.map(({ summary }) => <button key={summary.id} data-session={summary.id}
        onClick={() => void useAppStore.getState().selectSession(summary.id).catch((error) => errors.push(error))}>
        {summary.title}
      </button>)}
    </nav>
    <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
      <ChatTranscript key={id} sessionId={id} messages={messages} isRunning={running} />
      {id === "long-single-turn" && tab === `subagent:${id}-delegate` ?
        <aside style={{ width: 300 }}><SubagentTranscriptTab delegationId={`${id}-delegate`} /></aside> : null}
    </div>
    <Composer />
  </>;
}

/** Credential-free production React/store integration; no direct projection calls. */
export async function transcriptLongHistoryProbe() {
  // Store actions use the default i18next instance, not just React's provider.
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const originalDateNow = Date.now;
  const wallTime = Date.now();
  const originals = { getSession: api.getSession, listSessions: api.listSessions,
    pendingPlans: api.pendingPlans, listQueuedPrompts: api.listQueuedPrompts, composerCommands: api.composerCommands,
    summarizeSessionTitle: api.summarizeSessionTitle };
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const sessions = [history(100), history(1000), history(10784)];
  const records = new Map(sessions.map((item) => [item.summary.id, item]));
  const copied: string[] = [];
  const reads: { id: string; limit?: number }[] = [];
  const errors: unknown[] = [];
  const latencies: number[] = [];
  const longTasks: number[] = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : undefined;
  observer?.observe({ type: "longtask" });
  const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
  const heapBefore = heap();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const result = host.querySelector<T>(selector);
    assert(result, `missing ${selector}; render errors: ${errors.map(String)}`);
    return result;
  };
  const send = (sessionId: string, event: AgentEventEnvelope["event"]) => {
    useAppStore.getState().handleAgentEvent({ sessionId, turnId: `turn-${sessionId}`, ts: Date.now(), event });
  };
  const delta = (item: FixtureSession, text: string, id = item.tail) => send(item.summary.id, {
    type: "message_update", stream: "delta", deltaText: text,
    message: { id, role: "assistant", content: "", createdAt, status: "streaming" },
  });
  const settled = async () => {
    await frame(); await frame();
    await until(() => !host.querySelector('[data-transcript-settling="true"]'), "transcript veil");
    assert(errors.length === 0, `render/navigation errors: ${errors.map(String)}`);
  };
  const select = async (item: FixtureSession) => {
    flushSync(() => element<HTMLButtonElement>(`[data-session="${item.summary.id}"]`).click());
    await until(() => useAppStore.getState().activeSessionId === item.summary.id &&
      !useAppStore.getState().selectingSessionId, `select ${item.summary.id}`);
    await settled();
    assert(useAppStore.getState().messages.length === item.messages.length,
      `${item.summary.id}: bounded revalidation discarded loaded canonical history`);
  };
  const stream = async (item: FixtureSession, text: string) => {
    const start = performance.now();
    delta(item, text);
    await until(() => host.querySelector(`[data-message-id="${item.tail}"]`)?.textContent?.includes(text) === true, text);
    await settled();
    latencies.push(performance.now() - start);
  };
  const workCounts: { session: string; loaded: number; oldBodyReads: number; unchangedGroupRenders: number; mountedRows: number }[] = [];
  try {
    // Keep elapsed-label intervals deterministic without replacing rAF,
    // performance.now(), event batching, or React scheduling.
    Date.now = () => wallTime;
    // Only Host read/queue and clipboard boundaries are fixtures. No bootstrap,
    // provider invocation, filesystem service, or running Desktop is used.
    api.getSession = async (id, options) => {
      const item = records.get(id);
      assert(item, `unexpected session read ${id}`);
      reads.push({ id, limit: options?.messageLimit });
      const messages = options?.messageLimit ? item.messages.slice(-options.messageLimit) : item.messages;
      return { session: { ...item.summary, messages,
        messageStart: item.messages.length - messages.length, hasMoreBefore: messages.length < item.messages.length } };
    };
    api.listSessions = async () => ({ sessions: [...records.values()].map((item) => item.summary) });
    api.pendingPlans = async () => ({ plans: [], state: "inactive" });
    api.listQueuedPrompts = async () => ({ entries: [] });
    api.composerCommands = async () => ({ commands: [] });
    api.summarizeSessionTitle = async () => {
      const error = new Error("Unexpected auto-title provider request in synthetic fixture");
      errors.push(error);
      throw error;
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } } });
    useAppStore.setState({
      sessions: sessions.map((item) => item.summary), providers: [], providerModels: {},
      retainedTranscripts: {}, retainedSessionIds: [], sessionHistory: {}, sessionCompactions: {},
      pendingPlans: {}, pendingAsks: {}, pendingPermissions: {}, planningStates: {}, agentStatuses: {},
      latestTurnResults: {}, queuedPrompts: {}, notifications: [], workspace: undefined,
      runningSessions: Object.fromEntries(sessions.map((item) => [item.summary.id, true])),
      isRunning: true, page: "chat", selectingSessionId: undefined,
      settings: { defaultMode: "agent", theme: "dark", enterToSend: true, onboardingDismissed: true,
        ...initial.settings, smoothStreaming: false, thinkingDisplayMode: "detailed" },
    });
    // Seed canonical loaded snapshots through the real store subscription/cache
    // writer, rather than bypassing it with a projection builder or custom store.
    for (const item of sessions) useAppStore.setState({ activeSessionId: item.summary.id, messages: item.messages });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface sessions={sessions} errors={errors} /></I18nextProvider>));
    await settled();

    for (const item of sessions) {
      await select(item);
      await stream(item, " warm");
      item.reads.count = 0;
      globalThis.__activityGroupRenders = [];
      for (let index = 0; index < 3; index++) await stream(item, ` delta-${index}`);
      const sample = { session: item.summary.id, loaded: item.messages.length, oldBodyReads: item.reads.count,
        unchangedGroupRenders: globalThis.__activityGroupRenders.length,
        mountedRows: host.querySelectorAll(".message-row").length };
      workCounts.push(sample);
      assert(sample.oldBodyReads === 0, `${item.summary.id}: warmed deltas reread ${sample.oldBodyReads} unchanged bodies`);
      assert(sample.unchangedGroupRenders === 0, `${item.summary.id}: unchanged groups rendered ${sample.unchangedGroupRenders} times`);
      assert(sample.mountedRows < 150, `${item.summary.id}: mounted unbounded history (${sample.mountedRows})`);
      const scroller = element(".thread-scroll");
      await until(() => Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 2, "pinned follow");
      const editor = element(".composer-input");
      editor.focus();
      assert(document.activeElement === editor, "Composer lost keyboard focus during streaming");
    }

    // Both background caches receive deltas while the foreground stays exact.
    const foreground = useAppStore.getState().messages;
    const background = sessions.slice(0, 2);
    for (const item of background) { item.reads.count = 0; delta(item, " background-fresh"); }
    await settled();
    assert(useAppStore.getState().messages === foreground, "background deltas replaced foreground messages");
    for (const item of background) {
      assert(item.reads.count === 0, `${item.summary.id}: background delta reread old bodies`);
      await select(item);
      assert(element(`[data-message-id="${item.tail}"]`).textContent?.includes("background-fresh"), "switch lost cached background delta");
    }
    const largest = sessions[2];
    await select(largest);
    // A mounted older row must invalidate its own projection and minimap preview.
    const older = largest.messages[largest.messages.length - 7];
    send(largest.summary.id, { type: "message_end", message: { ...older, content: "Older row corrected", status: "complete" } });
    await until(() => host.textContent?.includes("Older row corrected") === true, "older row correction");
    await settled();
    const markers = [...host.querySelectorAll<HTMLButtonElement>(".minimap-marker.assistant")];
    assert(markers.length > 0, "minimap markers missing");
    let freshPreview = false;
    const previews: string[] = [];
    for (const marker of markers) {
      // show:false Electron updates activeElement without delivering focusin.
      // Deliver that DOM event explicitly; the production focus handler and
      // preview component still consume the real, corrected marker model.
      flushSync(() => {
        marker.focus();
        marker.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      const preview = host.querySelector(".minimap-popover")?.textContent ?? "<none>";
      previews.push(preview.slice(0, 64));
      if (preview.includes("Older row corrected")) {
        freshPreview = true; flushSync(() => marker.click()); break;
      }
    }
    assert(freshPreview, `minimap kept a stale older-row preview: ${JSON.stringify({ older: older.id, previews })}`);
    // Actual disclosure toggling hands scroll ownership to the reader.
    const disclosure = element<HTMLButtonElement>(".tool-activity-header");
    flushSync(() => disclosure.click());
    const expanded = disclosure.getAttribute("aria-expanded");
    await stream(largest, " while-reading");
    assert(disclosure.getAttribute("aria-expanded") === expanded, "stream reset explicit disclosure state");
    const scroller = element(".thread-scroll");
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -200 }));
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 240);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await settled();
    const readingTop = scroller.scrollTop;
    await stream(largest, " reader-stays");
    assert(Math.abs(scroller.scrollTop - readingTop) < 2, "stream stole the reader's scroll position");

    // Terminal re-key must replace exactly the provisional row, survive cache
    // reselection and expose fresh copy text through the real turn toolbar.
    const completed = { ...useAppStore.getState().messages.at(-1)!, id: `${largest.tail}-durable`,
      content: "Final canonical reply", status: "complete" as const };
    send(largest.summary.id, { type: "message_end", replacesMessageId: largest.tail, message: completed });
    send(largest.summary.id, { type: "agent_end", messageIds: [completed.id] });
    await until(() => host.textContent?.includes("Final canonical reply") === true && !useAppStore.getState().isRunning, "completion");
    await settled();
    assert(!useAppStore.getState().messages.some((message) => message.id === largest.tail), "provisional id survived terminal re-key");
    const final = element(`[data-message-id="${completed.id}"]`);
    const copy = final.closest(".message-row")?.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("chat.copy")}"]`);
    assert(copy, "completed assistant Copy action missing");
    flushSync(() => copy.click());
    await until(() => copied.length > 0, "copy reply");
    assert(copied.at(-1)?.includes("Final canonical reply") && copied.at(-1)?.includes("unchanged progress"), "copy lost full fresh turn text");
    // Advance the synthetic durable fixture, as persistence does after completion.
    largest.messages = useAppStore.getState().messages;
    await select(sessions[0]); await select(largest);
    assert(host.textContent?.includes("Final canonical reply"), "switch resurrected a pre-completion reply");
    assert(!host.querySelector(".transcript-runtime-status"), "finished session returned as running");

    for (const item of [giant(false), giant(true)]) {
      records.set(item.summary.id, item);
      flushSync(() => useAppStore.setState((state) => ({
        sessions: [...state.sessions, item.summary], activeSessionId: item.summary.id, messages: item.messages,
        isRunning: true, runningSessions: { ...state.runningSessions, [item.summary.id]: true },
      })));
      await settled(); await stream(item, " warm");
      item.reads.count = 0; globalThis.__activityGroupRenders = [];
      await stream(item, " giant-tail-fresh");
      const sample = { session: item.summary.id, loaded: item.messages.length, oldBodyReads: item.reads.count,
        unchangedGroupRenders: globalThis.__activityGroupRenders.length,
        mountedRows: host.querySelectorAll(".message-row").length };
      workCounts.push(sample);
      assert(sample.oldBodyReads === 0, `${item.summary.id}: reread ${sample.oldBodyReads} old bodies`);
      assert(sample.unchangedGroupRenders === 0, `${item.summary.id}: unchanged groups rerendered`);
      if (item.summary.id === "long-activity-group") {
        const groupHeader = element<HTMLButtonElement>(".process-activity-group > .tool-activity-header");
        if (groupHeader.getAttribute("aria-expanded") !== "true") flushSync(() => groupHeader.click());
        await settled();
        const updateThinking = (text: string) => send(item.summary.id, {
          type: "message_update", stream: "delta", deltaThinking: text,
          message: { id: `${item.summary.id}-thinking`, role: "assistant", content: "", createdAt, status: "streaming" },
        });
        const thinking = element<HTMLButtonElement>(".tool-row.thinking .tool-row-header");
        if (thinking.getAttribute("aria-expanded") !== "true") flushSync(() => thinking.click());
        updateThinking(" warm-thinking");
        await until(() => host.textContent?.includes("warm-thinking") === true, "warm giant thinking");
        await settled();
        item.reads.count = 0; globalThis.__activityGroupRenders = [];
        updateThinking(" giant-thinking-fresh");
        await until(() => host.textContent?.includes("giant-thinking-fresh") === true, "live giant group item");
        await settled();
        assert(item.reads.count === 0, `live giant group reread ${item.reads.count} completed tool bodies`);
        assert(globalThis.__activityGroupRenders.length === 1, "live giant group must render exactly its changed group");
        // A real tool_update targets a middle row, not the assistant tail. Warm
        // its output shape before counting unrelated completed body accesses.
        const liveToolId = `${item.summary.id}-tool-128`;
        const liveTool = element<HTMLButtonElement>(`[data-message-id="${liveToolId}"] .tool-row-header`);
        if (liveTool.getAttribute("aria-expanded") !== "true") flushSync(() => liveTool.click());
        send(item.summary.id, { type: "tool_update", toolCallId: liveToolId, partialResult: { details: { output: "warm tool output" } } });
        await until(() => host.querySelector(`[data-message-id="${liveToolId}"]`)?.textContent?.includes("warm tool output") === true,
          "warm tool_update output", () => ({
            message: useAppStore.getState().messages.find((message) => message.id === liveToolId),
            groupExpanded: groupHeader.getAttribute("aria-expanded"),
            toolExpanded: liveTool.getAttribute("aria-expanded"),
            toolDom: host.querySelector(`[data-message-id="${liveToolId}"]`)?.outerHTML.slice(-3000),
          }));
        await settled();
        item.reads.count = 0; globalThis.__activityGroupRenders = [];
        send(item.summary.id, { type: "tool_update", toolCallId: liveToolId, partialResult: { details: { output: "fresh non-tail tool output" } } });
        await until(() => host.querySelector(`[data-message-id="${liveToolId}"]`)?.textContent?.includes("fresh non-tail tool output") === true,
          "fresh tool_update output");
        await settled();
        assert(item.reads.count === 0, `tool_update reread ${item.reads.count} completed bodies`);
        assert(globalThis.__activityGroupRenders.length === 1, "tool_update must render exactly its changed group");
        const changed = item.messages[1];
        send(item.summary.id, { type: "message_end", message: { ...changed,
          toolArgs: { command: "printf changed-giant-tool" } } });
        await until(() => host.textContent?.includes("changed-giant-tool") === true, "giant group changed tool");
      } else {
        flushSync(() => element<HTMLButtonElement>(".subagent-topology-node-header").click());
        await until(() => host.querySelector('[data-testid="subagent-transcript-tab"]') !== null, "child transcript dock");
        const parent = useAppStore.getState().messages[1];
        send(item.summary.id, { type: "message_update", stream: "delta", deltaText: " child-fresh",
          message: { id: `${item.summary.id}-child`, role: "assistant", content: "", createdAt, status: "streaming",
            parentToolCallId: parent.toolCallId, agentName: "explorer" } });
        await until(() => host.querySelector('[data-testid="subagent-transcript-tab"]')?.textContent?.includes("child-fresh") === true,
          "nested child update");
        assert(useAppStore.getState().messages[1] === parent, "child update replaced its stable parent Task");
      }
    }
    assert(reads.every((read) => read.limit === 100), "ordinary selection requested unbounded Host history");
    assert(errors.length === 0, `render errors: ${errors.map(String)}`);
    return { ok: true, workCounts, hostPageSize: 100, simultaneousRunningSessions: 3,
      diagnostics: { eventToSettledDomMs: latencies, longTasksMs: observer ? longTasks : null,
        heapBefore, heapAfter: heap() } };
  } finally {
    flushSync(() => root.unmount());
    Date.now = originalDateNow;
    observer?.disconnect(); host.remove();
    Object.assign(api, originals);
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    useAppStore.setState(initial, true);
  }
}
