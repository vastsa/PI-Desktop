import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { AppState } from "../../apps/desktop/src/stores/app-state";
import { getTranscriptReadingPosition } from "../../apps/desktop/src/lib/transcript-reading-position";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let index = 0; index < 240; index++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}
function Surface() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return <>
    <div className="session-panes">
      {retained.map((id) => <SessionPane key={id} sessionId={id} visible={id === active} />)}
    </div>
    <Composer />
  </>;
}

declare global { var transcriptLiveTailProbe: () => Promise<unknown>; }
globalThis.transcriptLiveTailProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host);
  const createdAt = new Date(Date.now() - 30_000).toISOString();
  const user: UiMessage = { id: "live-user", role: "user",
    content: Array.from({ length: 30 }, (_, index) => `Inspect file ${index}.`).join("\n\n"), createdAt };
  const tool: UiMessage = { id: "live-tool", role: "tool", content: "file contents", toolName: "Read",
    toolStatus: "success", toolCallId: "live-read", createdAt };
  const answer: UiMessage = { id: "live-answer", role: "assistant", content: "Still inspecting.", status: "streaming", createdAt };
  let messages = [user, tool, answer];
  const set = (patch: Partial<AppState>) => flushSync(() => useAppStore.setState(patch));
  const label = () => host.querySelector('[data-session-pane="live-tail"] .tool-activity-label');
  const activeLabel = () => Boolean(label()?.classList.contains("running"));
  const stop = () => host.querySelector('[aria-label="' + i18n.t("chat.stopGenerating") + '"]');
  try {
    set({
      activeSessionId: "live-tail", selectingSessionId: "live-tail", messages,
      retainedSessionIds: ["live-tail", "other-tail"], retainedTranscripts: { "other-tail": [] },
      sessions: ["live-tail", "other-tail"].map((id) => ({ id, title: id, mode: "agent", permissionMode: "ask",
        thinkingLevel: "off", createdAt, updatedAt: createdAt, messageCount: messages.length })),
      sessionHistory: {}, transcriptViews: {}, sessionCompactions: {}, pendingPlans: {},
      pendingPermissions: {}, pendingAsks: {}, planningStates: {}, agentStatuses: {},
      runningSessions: { "live-tail": true }, isRunning: true, queuedPrompts: {},
      providers: [], providerModels: {}, plugins: [], workspace: undefined,
      settings: { defaultMode: "agent", theme: "light", enterToSend: true, onboardingDismissed: true,
        ...initial.settings, smoothStreaming: false },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface /></I18nextProvider>));
    await frame();
    assert(activeLabel(), "ordinary live process must be running");
    assert(stop(), "the running composer must offer Stop");
    const canonicalScroller = host.querySelector<HTMLElement>('[data-session-pane="live-tail"] .thread-scroll')!;
    canonicalScroller.style.flex = "0 0 120px";
    const atBottom = () => Math.abs(canonicalScroller.scrollHeight - canonicalScroller.clientHeight - canonicalScroller.scrollTop) < 2;
    await until(() => canonicalScroller.scrollHeight > canonicalScroller.clientHeight + 200 && atBottom(),
      "the initial running pane overflows and follows latest");
    canonicalScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    canonicalScroller.scrollTop = 160;
    canonicalScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    assert(getTranscriptReadingPosition("live-tail")?.pinned === false,
      `reading history must record an unpinned bookmark: ${JSON.stringify(getTranscriptReadingPosition("live-tail"))}`);
    const jump = host.querySelector<HTMLButtonElement>('[data-session-pane="live-tail"] .jump-latest-btn')!;
    assert(jump, "history reading offers return to latest");
    // Do not yield to a native scroll event between the click and hiding the
    // pane. A smooth scroll has not reached the bottom when navigation wins.
    flushSync(() => jump.click());
    assert(getTranscriptReadingPosition("live-tail")?.pinned === true,
      "return to latest must synchronously replace the old reading bookmark");
    set({ activeSessionId: "other-tail", messages: [], isRunning: false,
      retainedTranscripts: { "live-tail": messages, "other-tail": [] } });
    set({ activeSessionId: "live-tail", messages, isRunning: true });
    await until(atBottom, "an immediate retained return stays pinned");
    assert(!host.querySelector('[data-session-pane="live-tail"] .jump-latest-btn'),
      "retained reveal must not resurrect the old unpinned bookmark");
    // A project switch drops the original DOM entirely. Its bookmark must
    // still preserve the explicit follow intent across the fresh mount.
    canonicalScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    canonicalScroller.scrollTop = 160;
    canonicalScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-session-pane="live-tail"] .jump-latest-btn')!.click());
    set({ activeSessionId: "other-tail", messages: [], isRunning: false,
      retainedSessionIds: ["other-tail"], retainedTranscripts: { "other-tail": [] } });
    await frame();
    assert(!host.querySelector('[data-session-pane="live-tail"]'), "project switch must unmount the original pane");
    messages = [user, tool, { ...answer, content: "Output while the project was hidden." }];
    set({ activeSessionId: "live-tail", messages, isRunning: true,
      retainedSessionIds: ["live-tail", "other-tail"] });
    await until(() => {
      const current = host.querySelector<HTMLElement>('[data-session-pane="live-tail"] .thread-scroll');
      return Boolean(current && Math.abs(current.scrollHeight - current.clientHeight - current.scrollTop) < 2);
    }, "a project return follows output produced while hidden");
    assert(activeLabel() && stop(), "project return must remain visibly running");
    assert(!host.querySelector('[data-session-pane="live-tail"] .jump-latest-btn'),
      "remount must not require a second return-to-latest click");
    set({ messages: [], selectingSessionId: undefined });
    await frame();
    assert(host.querySelector('[data-session-pane="live-tail"] [data-testid="working-indicator"]'),
      "an empty canonical transcript still shows the initial model wait");
    set({ transcriptViews: { "live-tail": {
      messages: [], messageStart: 0, hasMoreBefore: false, hasMoreAfter: false,
      focus: null, restored: true, loading: null,
    } } });
    await frame();
    assert(!host.querySelector('[data-session-pane="live-tail"] .transcript-runtime-status > *'),
      "an empty restored range cannot prove it reaches a canonical live tail");
    set({ messages, transcriptViews: {}, selectingSessionId: "live-tail" });
    await frame();
    const bookmark = { pinned: false, messageId: user.id, offset: 0, scrollTop: 0, windowSize: 60 };
    // Public restore action used by a retained pane during selection revalidation.
    await useAppStore.getState().restoreTranscriptReading("live-tail", bookmark, new AbortController().signal);
    await frame();
    assert(useAppStore.getState().transcriptViews["live-tail"]?.restored, "exercise an actual restored view");
    assert(activeLabel(), "restored live tail must not say Finished while the composer can stop it");
    const duration = () => host.querySelector('[data-session-pane="live-tail"] .turn-duration')?.textContent;
    const beforeTick = duration();
    await until(() => duration() !== beforeTick, "elapsed time keeps ticking without output deltas");
    set({ planningStates: { "live-tail": "planning" } });
    assert(host.querySelector('[data-session-pane="live-tail"] [data-testid="planning-indicator"]'),
      "restored live tail keeps its planning feedback");
    set({ planningStates: {}, pendingPermissions: { "live-tail": [{
      sessionId: "live-tail", requestId: "permission", toolCallId: "permission-call", toolName: "Bash",
      argsPreview: { command: "pwd" }, risk: "low", reason: "fixture",
    }] } });
    assert(host.querySelector('[data-session-pane="live-tail"] .permission-card button'),
      "restored live tail must not hide an actionable approval");
    assert(!host.querySelector('[data-session-pane="live-tail"] .transcript-runtime-status > *'),
      "approval replaces generic running feedback");
    set({ pendingPermissions: {}, pendingAsks: { "live-tail": [{
      sessionId: "live-tail", requestId: "question", toolCallId: "question-call",
      questions: [{ question: "Continue?", options: ["Yes", "No"] }],
    }] } });
    assert(!host.querySelector('[data-session-pane="live-tail"] .transcript-runtime-status > *'),
      "a question replaces generic running feedback in a restored live tail");
    set({ pendingAsks: {} });
    const reading = useAppStore.getState().transcriptViews["live-tail"];
    const scroll = host.querySelector<HTMLElement>('[data-session-pane="live-tail"] .thread-scroll')!;
    assert(scroll.scrollHeight > scroll.clientHeight + 200, "exercise an overflowing transcript");
    scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    scroll.scrollTop = 160;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const scrollTop = scroll.scrollTop;
    assert(scrollTop > 0 && scrollTop < scroll.scrollHeight - scroll.clientHeight,
      "the reader must be away from both ends of the transcript");
    messages = [user, tool, { ...answer, content: "Output continues after restoration." }];
    set({ messages, selectingSessionId: undefined });
    await frame();
    assert(host.textContent?.includes("Output continues after restoration."), "canonical output must keep updating");
    assert(activeLabel(), "a content delta must not turn the header into Finished");
    assert(useAppStore.getState().transcriptViews["live-tail"] === reading && scroll.scrollTop === scrollTop,
      "live status must preserve the restored range and reading offset");
    set({ activeSessionId: "other-tail", messages: [], retainedTranscripts: { "live-tail": messages, "other-tail": [] }, isRunning: false });
    await frame();
    assert(!host.querySelector('[data-session-pane="other-tail"] .turn-process.active'), "running state must not leak to another session");
    set({ activeSessionId: "live-tail", messages, isRunning: true });
    await frame();
    assert(activeLabel(), "revealing a retained running session must preserve its status");
    const view = useAppStore.getState().transcriptViews["live-tail"]!;
    set({ transcriptViews: { "live-tail": { ...view, hasMoreAfter: true } } });
    await frame();
    assert(!activeLabel(), "a restored page with an unread gap remains historical");
    set({ transcriptViews: { "live-tail": { ...view, focus: { sessionId: "live-tail", messageId: user.id, query: "", requestId: 1 } } } });
    await frame();
    assert(!activeLabel(), "an explicit search at the tail must not claim a live process");
    set({ transcriptViews: { "live-tail": { ...view, messages: [
      { ...user, id: "disjoint-user" }, { ...tool, id: "disjoint-tool" },
    ] } } });
    await frame();
    assert(!activeLabel(), "a disjoint range must not claim the canonical live turn");
    const copiedTool = { ...tool };
    set({ messages: [tool], transcriptViews: { "live-tail": {
      ...view, messages: [copiedTool], parentMessage: copiedTool,
    } } });
    await frame();
    assert(activeLabel(), "a restored canonical message keeps its identity across history object copies");
    set({ messages });
    set({ transcriptViews: { "live-tail": view }, runningSessions: {}, isRunning: false });
    await frame();
    assert(label()?.textContent === i18n.t("chat.processCompleted") && !activeLabel(), "only settled run state shows Finished");
    set({ messages: [user, tool, { ...answer, status: "aborted" }] });
    await frame();
    assert(label()?.textContent === i18n.t("chat.processStopped"), "abort retains its stopped status");
    set({ messages: [user, tool, { ...answer, status: "complete", error: {
      code: "UNKNOWN", message: "Fixture failure", retriable: false,
    } }] });
    await frame();
    assert(label()?.textContent === i18n.t("chat.processFailed"), "failure retains its failed status");
    return { ok: true, restoredLiveStatus: true, retainedSessionStatus: true,
      historicalIsolation: true, returnToLatestRetention: true, projectReturnFollow: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), label: label()?.textContent, stop: Boolean(stop()) };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(initial);
  }
};
