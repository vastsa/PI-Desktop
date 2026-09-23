import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { createTranscriptReadingRuntime } from "../../apps/desktop/src/stores/runtime/transcript-reading-runtime";

type ReadSession = Parameters<typeof createTranscriptReadingRuntime>[1];
type ReadResult = Awaited<ReturnType<ReadSession>>;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function frames(count: number) { for (let i = 0; i < count; i++) await frame(); }

function RetainedPanes() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return <div className="chat-surface" style={{ flex: 1, minHeight: 0 }}>
    <div className="session-panes">
      {retained.map((id) => <SessionPane key={id} sessionId={id} visible={id === active} />)}
    </div>
  </div>;
}

/** Only the external session read is gated; paging and view publication are production code. */
export async function verifyRetainedPage(
  i18n: i18n,
  recent: UiMessage[],
  older: UiMessage[],
  tail: UiMessage[],
  resolveWhileHidden: boolean,
) {
  const original = useAppStore.getState();
  const id = `scroll-retained-page-${resolveWhileHidden ? "hidden" : "visible"}`;
  const otherId = `${id}-other`;
  const otherMessages: UiMessage[] = [{
    id: `${otherId}-message`, role: "user", content: "Another retained conversation",
    createdAt: "2026-09-22T00:00:00Z",
  }];
  const summaries: SessionSummary[] = [id, otherId].map((sessionId) => ({
    id: sessionId, title: sessionId, messageCount: sessionId === id ? recent.length + older.length * 2 : 1,
    mode: "agent", permissionMode: "ask", thinkingLevel: "off",
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
  }));
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;--composer-dock-height:180px";
  document.body.append(host);
  const errors: string[] = [];
  const failures: string[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(String(error)) });
  const reads: {
    sessionId: string; options: Parameters<ReadSession>[1]; hidden: boolean;
    finish: (result: ReadResult) => void; promise: Promise<ReadResult>;
  }[] = [];
  const runtime = createTranscriptReadingRuntime(
    { get: useAppStore.getState, set: useAppStore.setState },
    (sessionId, options) => {
      let finish!: (result: ReadResult) => void;
      const promise = new Promise<ReadResult>((resolve) => { finish = resolve; });
      reads.push({ sessionId, options, hidden: useAppStore.getState().activeSessionId !== sessionId, finish, promise });
      return promise;
    },
  );
  // Keep the store's production reconciliation subscription, replacing only
  // its runtime's external read dependency rather than mocking loadTranscriptPage.
  let trustedWheels = 0;
  const onWheel = (event: WheelEvent) => { if (event.isTrusted) trustedWheels++; };
  host.addEventListener("wheel", onWheel, { passive: true, capture: true });
  const pane = () => {
    const element = host.querySelector<HTMLElement>(`[data-session-pane="${id}"]`);
    if (!element) throw new Error(`retained pane missing: ${errors.join(", ")}`);
    return element;
  };
  const scroller = () => {
    const element = pane().querySelector<HTMLElement>(".thread-scroll");
    if (!element) throw new Error("retained pane scroller missing");
    return element;
  };
  const wheel = async (deltaY: number) => {
    const rect = scroller().getBoundingClientRect();
    await globalThis.scrollProbeDriver.wheel({
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), deltaY,
    });
  };
  const select = (sessionId: string) => flushSync(() => useAppStore.setState({
    activeSessionId: sessionId, messages: sessionId === id ? recent : otherMessages,
  }));
  try {
    useAppStore.setState({
      ...runtime.actions,
      activeSessionId: id, messages: recent, sessions: summaries,
      retainedSessionIds: [id, otherId], retainedTranscripts: { [id]: recent, [otherId]: otherMessages },
      sessionHistory: { [id]: { messageStart: older.length * 2, hasMoreBefore: true } },
      transcriptViews: {}, runningSessions: {}, isRunning: false,
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><RetainedPanes /></I18nextProvider>));
    let previous = "";
    let stable = 0;
    for (let attempt = 0; attempt < 180; attempt++) {
      await frame();
      const scroll = scroller();
      const current = `${scroll.scrollTop}:${scroll.scrollHeight}:${scroll.clientHeight}`;
      stable = current === previous && !pane().querySelector(".transcript-settle-veil") ? stable + 1 : 0;
      if (stable >= 4) break;
      previous = current;
    }
    if (stable < 4) throw new Error("retained pane never settled");
    if (reads.length) failures.push("retained pane paged before native history movement");
    await wheel(200 - scroller().scrollTop);
    await frames(12);
    if (Math.abs(scroller().scrollTop - 200) > 2) throw new Error("retained pane did not reach the history approach position");
    await wheel(-120);
    await frames(14);
    if (!reads[0]) throw new Error("retained pane did not request its older page");
    const pendingTop = scroller().scrollTop;
    await wheel(-24);
    await frames(12);
    const furtherMovement = pendingTop - scroller().scrollTop;
    if (Math.abs(furtherMovement - 24) > 2) failures.push(`pending page lost native movement (${furtherMovement}px)`);
    if (useAppStore.getState().transcriptViews[id]?.loading !== "before") failures.push("older read was not pending during native movement");

    const retainedPane = pane();
    const retainedScroller = scroller();
    const viewport = retainedScroller.getBoundingClientRect();
    const readingMessage = [...retainedPane.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => {
      const rect = node.getBoundingClientRect();
      return node.closest("[data-scroll-owner]") === retainedScroller &&
        rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
    });
    const messageId = readingMessage?.getAttribute("data-message-id");
    if (!readingMessage || !messageId) throw new Error("retained pane has no visible message identity");
    const before = readingMessage.getBoundingClientRect().top - viewport.top;
    let phase = "before-hide";
    const sample = () => {
      const visible = pane().dataset.visible === "true";
      // Never force layout inside content-visibility:hidden to measure an anchor.
      const scroll = visible ? scroller() : null;
      const row = visible ? pane().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`) : null;
      if (visible && (!row || !scroll)) throw new Error(`reading message ${messageId} disappeared during ${phase}`);
      return {
        phase, visible, messageId, reads: reads.length,
        offset: row && scroll ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null,
        top: scroll?.scrollTop ?? null,
        max: scroll ? scroll.scrollHeight - scroll.clientHeight : null,
        jump: visible && Boolean(pane().querySelector(".jump-latest-btn")),
        loading: useAppStore.getState().transcriptViews[id]?.loading ?? null,
      };
    };
    const samples = [sample()];
    const sampleFrames = async (count: number) => {
      for (let i = 0; i < count; i++) { await frame(); samples.push(sample()); }
    };
    const publish = () => reads[0].finish({ session: {
      ...summaries[0], messages: older, messageStart: older.length, messageEnd: older.length * 2,
      // Leave an earlier edge available so "no hidden paging" is not vacuous.
      hasMoreBefore: true, hasMoreAfter: true,
    } });
    phase = "hidden-pending";
    select(otherId);
    if (pane() !== retainedPane || pane().getAttribute("aria-hidden") !== "true" || !pane().inert) {
      failures.push("switch did not retain and hide the original pane");
    }
    samples.push(sample());
    await sampleFrames(6);
    if (resolveWhileHidden) {
      phase = "hidden-published";
      publish();
      await sampleFrames(8);
      if (useAppStore.getState().transcriptViews[id]?.messages[0]?.id !== older[0].id) {
        failures.push("hidden page did not publish through the reading runtime");
      }
    }
    phase = "reveal-commit";
    select(id);
    samples.push(sample()); // The synchronous reveal commit, before waiting for a frame.
    if (pane() !== retainedPane || scroller() !== retainedScroller) failures.push("reveal remounted the retained pane");
    phase = "reveal-frames";
    await sampleFrames(6);
    if (!resolveWhileHidden) {
      phase = "visible-published";
      publish();
      samples.push(sample());
    }
    await sampleFrames(16);
    const view = useAppStore.getState().transcriptViews[id];
    const expectedIds = [...older, ...recent].map((message) => message.id);
    if (JSON.stringify(view?.messages.map((message) => message.id)) !== JSON.stringify(expectedIds) || view?.loading) {
      failures.push("older page was not published exactly once into the production reading view");
    }
    if (!pane().querySelector(`[data-message-id="${CSS.escape(older[0].id)}"]`)) failures.push("published older page never reached the pane DOM");
    if (useAppStore.getState().messages !== recent) failures.push("paging replaced the canonical live transcript");

    // Content growth after reveal must still leave follow released.
    const beforeGrowth = scroller().scrollHeight;
    phase = "tail-growth-commit";
    flushSync(() => useAppStore.setState({ messages: [...recent, ...tail] }));
    samples.push(sample());
    phase = "tail-growth-frames";
    await sampleFrames(16);
    if (scroller().scrollHeight <= beforeGrowth) failures.push("follow check did not grow the live tail");
    const visibleSamples = samples.filter((entry) => entry.visible);
    const shift = Math.max(...visibleSamples.map((entry) => Math.abs(entry.offset! - before)));
    if (shift > 2) failures.push(`retained pending page (hidden completion=${resolveWhileHidden}) shifted ${messageId} by ${shift}px`);
    if (visibleSamples.some((entry) => !entry.jump || entry.max! - entry.top! <= 48)) failures.push("retained paging resumed follow without user input");
    if (reads.length !== 1) failures.push(`retained pending page issued ${reads.length} external reads`);
    if (reads.some((read) => read.hidden)) failures.push("a hidden retained pane requested history");
    const request = reads[0];
    if (request.sessionId !== id || request.options.messageBefore !== older.length * 2 ||
      request.options.messageLimit !== 100 || request.options.contentLimit !== 65_536) {
      failures.push("older page did not use the production bounded read contract");
    }
    if (trustedWheels !== 3) failures.push(`retained fixture received ${trustedWheels} trusted wheels instead of 3`);
    if (errors.length) failures.push(`retained pane render errors: ${errors.join(", ")}`);
    return {
      name: "page-across-pane-reveal", resolveWhileHidden, failures, trustedWheels,
      reads: reads.map(({ sessionId, options, hidden }) => ({ sessionId, options, hidden })),
      furtherMovement, before, shift, samples,
    };
  } finally {
    try {
      flushSync(() => root.unmount());
    } finally {
      // Invalidate ownership before releasing even unexpected duplicate reads.
      // Drain their continuations before restoring the original store/actions.
      for (const sessionId of [id, otherId]) runtime.actions.returnToLatestTranscript(sessionId);
      for (const read of reads) read.finish({ session: null });
      await Promise.all(reads.map((read) => read.promise));
      await Promise.resolve();
      host.removeEventListener("wheel", onWheel, true);
      host.remove();
      useAppStore.setState(original, true);
    }
  }
}
