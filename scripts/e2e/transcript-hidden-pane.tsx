import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { SubagentRunRows, ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { ActivityGroup, RunActivityIndicator, WorkingIndicator } from "../../apps/desktop/src/features/chat/transcript/ActivityGroup";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { SubagentRunItem } from "../../apps/desktop/src/lib/assistant-turns";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Real retained pane and leaf components; fake only the clock and external RPC. */
export async function transcriptHiddenPaneProbe() {
  const i18n = createInstance();
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
  const initialState = useAppStore.getState();
  const sessionId = "hidden-pane-fixture";
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const output = Array.from({ length: 400 }, (_, index) => `line ${index}: preserved output`).join("\n");
  const tool: UiMessage = { id: "hidden-grep", role: "tool", toolName: "Grep", toolArgs: { pattern: "fixture" }, toolStatus: "running", toolResult: output, content: "", createdAt, turnId: "hidden-turn" };
  let rows: UiMessage[] = [
    { id: "hidden-user", role: "user", content: "inspect", createdAt, turnId: "hidden-turn" },
    tool,
    { id: "hidden-answer", role: "assistant", content: "partial answer", status: "streaming", createdAt, turnId: "hidden-turn" },
  ];
  const task: UiMessage = { id: "hidden-task", role: "tool", toolName: "Task", toolArgs: { agent: "explorer", task: "fixture" }, toolStatus: "running", toolResult: { details: { delegationId: "hidden-delegate", status: "running", startedAt: Date.now() - 10_000 } }, content: "", createdAt };
  const taskItems = [{ kind: "tool" as const, message: task }];
  let delegateItems: SubagentRunItem[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "answer", message: { id: `hidden-delegate-${index}`, role: "assistant", content: `delegate row ${index}`, createdAt },
  }));
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const native = { interval: window.setInterval, clearInterval: window.clearInterval, raf: window.requestAnimationFrame, cancelRaf: window.cancelAnimationFrame, now: Date.now };
  let now = Date.now();
  const startedAt = now - 10_000;
  let nextId = 1;
  const intervals = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  window.setInterval = ((callback: TimerHandler) => {
    assert(typeof callback === "function", "interval must use a callback");
    const id = nextId++;
    intervals.set(id, () => callback());
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = (id) => { intervals.delete(id); };
  window.requestAnimationFrame = (callback) => { const id = nextId++; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  Date.now = () => now;
  const advance = () => {
    now += 1000;
    flushSync(() => {
      for (const callback of [...intervals.values()]) callback();
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(performance.now() + 1000);
    });
  };
  const yieldToEffects = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const until = async (ready: () => boolean, label: string) => {
    for (let frame = 0; frame < 120 && !ready(); frame++) {
      await new Promise<void>((resolve) => native.raf.call(window, () => resolve()));
    }
    assert(ready(), label);
  };
  const render = (visible: boolean) => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <SessionPane sessionId={sessionId} visible={visible} />
      <TranscriptDisclosureProvider sessionId={`${sessionId}-leaves`} visible={visible}>
        <div data-hidden-leaves>
          <ActivityGroup items={taskItems} isActive />
          <ToolRow message={task} variant="topology" />
          <WorkingIndicator startedAt={startedAt} />
          <RunActivityIndicator activity={{ phase: "waiting-model", since: startedAt }} />
          <SubagentRunRows run={{ items: delegateItems }} agentName="explorer" />
        </div>
      </TranscriptDisclosureProvider>
    </I18nextProvider>,
  ));
  try {
    useAppStore.setState({
      activeSessionId: sessionId, page: "chat", messages: rows,
      sessions: [{ id: sessionId, title: "Fixture", createdAt, updatedAt: createdAt, source: "desktop", mode: "agent" }],
      retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: rows },
      sessionHistory: {}, transcriptViews: {}, planningStates: {},
      pendingPermissions: {}, pendingAsks: {}, runningSessions: { [sessionId]: true }, isRunning: true,
      agentStatuses: { [sessionId]: { isRunning: true, currentTurnId: "hidden-turn", activity: { phase: "waiting-model", since: now - 10_000 } } },
      settings: { ...initialState.settings, smoothStreaming: true },
    });
    render(true);
    await yieldToEffects();
    const processHeader = host.querySelector<HTMLButtonElement>(".turn-process > .tool-activity-header");
    if (processHeader?.getAttribute("aria-expanded") === "false") flushSync(() => processHeader.click());
    const pane = host.querySelector<HTMLElement>(`[data-session-pane="${sessionId}"]`);
    const nested = host.querySelector<HTMLElement>("[data-hidden-leaves] .subagent-run-rows");
    assert(nested, "real nested delegate scroller must be mounted");
    nested.style.maxHeight = "120px";
    advance();
    flushSync(() => {
      nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true }));
      nested.scrollTop = 73;
      nested.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const nestedScrollTop = nested.scrollTop;
    assert(nestedScrollTop > 0, "nested output must overflow and leave follow mode");
    rows = rows.map((message) => message.id === "hidden-answer"
      ? { ...message, content: `${message.content}${" visible pending answer".repeat(8)}` } : message);
    flushSync(() => useAppStore.setState({ messages: rows, retainedTranscripts: { [sessionId]: rows } }));
    await yieldToEffects();
    await until(() => frames.size > 0, "visible smooth output must have pending release work");
    const header = pane?.querySelector<HTMLButtonElement>('[data-message-id="hidden-grep"] .tool-row-header');
    assert(pane && header, `real pane failed to mount: ${errors.map(String).join("; ")}`);
    flushSync(() => header.click());
    const body = pane.querySelector<HTMLElement>('[data-message-id="hidden-grep"] .tool-row-content');
    const thread = pane.querySelector<HTMLElement>(".thread-scroll");
    assert(body && thread, `open tool output and retained thread must be mounted: ${JSON.stringify({ expanded: header.getAttribute("aria-expanded"), disabled: header.disabled, thread: Boolean(thread), tool: header.closest(".tool-row")?.outerHTML.slice(-2500), errors: errors.map(String) })}`);
    body.scrollTop = 73;
    const scrollTop = body.scrollTop;
    const content = body.textContent;
    const answer = pane.querySelector<HTMLElement>('[data-message-id="hidden-answer"] .prose-chat');
    assert(answer, "streaming assistant output must be mounted");
    const answerContent = answer.textContent;
    assert(scrollTop > 0, "fixture output must overflow to prove reading position retention");
    const visibleTimers = intervals.size;
    assert(visibleTimers > 0, "visible live clocks must be active");
    render(false);
    flushSync(() => useAppStore.setState({ activeSessionId: "other-fixture", messages: [], isRunning: false }));
    rows = rows.map((message) => message.id === "hidden-grep" ? { ...message, toolResult: `${output}\nhidden output arrives` }
      : message.id === "hidden-answer" ? { ...message, content: `${message.content} hidden answer arrives` } : message);
    flushSync(() => useAppStore.setState({ retainedTranscripts: { [sessionId]: rows } }));
    delegateItems = [...delegateItems, { kind: "answer", message: {
      id: "hidden-delegate-new", role: "assistant", content: "hidden delegate answer arrives", createdAt,
    } }];
    render(false);
    await yieldToEffects();
    // Drain one-shot work from mounting; recurring hidden work must be absent.
    advance();
    advance();
    const hiddenTimers = intervals.size;
    const hiddenFrames = frames.size;
    const sameOutput = body.textContent === content;
    const sameAnswer = answer.textContent === answerContent;
    const retained = pane.querySelector('.tool-row-content') === body && body.scrollTop === scrollTop
      && header.getAttribute("aria-expanded") === "true" && pane.querySelector(".thread-scroll") === thread;
    const sameDelegate = !nested.textContent?.includes("hidden delegate answer arrives");
    const nestedRetained = nested.scrollTop === nestedScrollTop
      && host.querySelector("[data-hidden-leaves] .subagent-run-rows") === nested;
    render(true);
    flushSync(() => useAppStore.setState({ activeSessionId: sessionId, messages: rows, isRunning: true }));
    await yieldToEffects();
    const catchUpState = { tool: Boolean(body.textContent?.includes("hidden output arrives")), answer: Boolean(pane.textContent?.includes("hidden answer arrives")), text: answer.textContent?.slice(-120), pendingFrames: frames.size };
    const caughtUp = catchUpState.tool && catchUpState.answer;
    const delegateCaughtUp = nested.textContent?.includes("hidden delegate answer arrives")
      && nested.scrollTop === nestedScrollTop;
    const resumed = intervals.size > 0;
    flushSync(() => header.click());
    render(false);
    render(true);
    const manualChoice = header.getAttribute("aria-expanded") === "false";
    assert(hiddenTimers === 0, `hidden pane retained ${hiddenTimers} recurring clocks`);
    assert(hiddenFrames === 0, `hidden pane retained ${hiddenFrames} animation frames`);
    assert(sameOutput, "hidden output formatting should remain deferred");
    assert(sameAnswer, "hidden assistant text must retain its last visible rendering");
    assert(sameDelegate && nestedRetained, "hidden delegate work must retain rendering and nested reading position");
    assert(delegateCaughtUp, "delegate output must catch up without re-pinning the reader");
    assert(retained, "visibility swap must retain DOM, disclosure and nested scroll position");
    assert(caughtUp, `reopening must show latest stored tool output and assistant text: ${JSON.stringify(catchUpState)}`);
    assert(resumed && manualChoice, "visible clocks resume without resetting an explicit disclosure choice");
    assert(errors.length === 0, errors.map(String).join("; "));
    flushSync(() => root.unmount());
    assert(intervals.size === 0 && frames.size === 0, "unmount must release timers and animation frames");
    return { ok: true, visibleTimers, hiddenTimers, hiddenFrames, sameOutput, sameAnswer, sameDelegate, retained, nestedRetained, caughtUp, delegateCaughtUp, resumed, manualChoice };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.setInterval = native.interval;
    window.clearInterval = native.clearInterval;
    window.requestAnimationFrame = native.raf;
    window.cancelAnimationFrame = native.cancelRaf;
    Date.now = native.now;
    useAppStore.setState(initialState);
  }
}
