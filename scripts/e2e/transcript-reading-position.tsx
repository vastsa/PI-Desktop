import "./session-reading-position";
import "./transcript-continuation";
import "./transcript-live-tail";
import { useCallback } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { UiMessage } from "@pi-desktop/shared";
import { useTranscriptScroll } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll";
import { transcriptEntryMessages } from "../../apps/desktop/src/lib/assistant-turns";
import { retainSessionPane, type RetainedPanes } from "../../apps/desktop/src/lib/session-panes";
import { sessionReadingState, type TranscriptReadingPosition } from "../../apps/desktop/src/lib/transcript-reading-position";
import { TranscriptDisclosureProvider, useAutomaticDisclosure } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { DisclosureAnchorContext } from "../../apps/desktop/src/lib/disclosure-anchor-context";

const messages: UiMessage[] = Array.from({ length: 100 }, (_, index) => ({
  id: `m${index}`, role: "user", content: `Message ${index}`,
  createdAt: "2026-09-01T00:00:00Z", status: "complete",
}));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let finishDeferredRestore: ((found: boolean) => void) | undefined;
let deferredRestoreAborted = false;
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 180; i++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}

function Row({ message }: { message: UiMessage }) {
  const disclosure = useAutomaticDisclosure(false, undefined, message.id);
  return <div data-message-id={message.id} style={{ height: disclosure.open ? 500 : 100 }}>
    <button ref={disclosure.titleRef} onClick={disclosure.toggle}>{message.content}</button>
    {disclosure.open ? <div data-expanded="true" ref={disclosure.bodyRef}>Expanded reading content</div> : null}
  </div>;
}

function Pane({ id, visible, running }: { id: string; visible: boolean; running: boolean }) {
  const onRestoreReading = useCallback((position: TranscriptReadingPosition, signal: AbortSignal) => {
    if (id === "G") return new Promise<boolean>((resolve) => {
      finishDeferredRestore = resolve;
      signal.addEventListener("abort", () => { deferredRestoreAborted = true; }, { once: true });
    });
    return Promise.resolve(!signal.aborted && messages.some((message) => message.id === position.messageId));
  }, [id]);
  const scroll = useTranscriptScroll({
    sessionId: id, messages, hasMoreBefore: false, isRunning: running,
    askPending: false, approvalPending: false, paneVisible: visible,
    searchTarget: null, readingWindow: false, onRestoreReading,
  });
  const rows = transcriptEntryMessages(scroll.tailEntry
    ? [...scroll.historyEntries, scroll.tailEntry] : scroll.historyEntries);
  return <div data-pane={id} style={visible
    ? { position: "absolute", inset: 0 }
    : { position: "absolute", inset: 0, visibility: "hidden", contentVisibility: "hidden" }}>
    <div ref={scroll.wrapRef} style={{ height: "100%" }}>
      <div ref={scroll.scrollRef} onScroll={scroll.handleScroll}
        style={{ height: "100%", overflowY: "auto", overflowAnchor: "none" }}>
        <div ref={scroll.contentRef}>
          <TranscriptDisclosureProvider sessionId={id}>
            <DisclosureAnchorContext.Provider value={scroll.disclosureAnchorNotifier}>
              {rows.map((message) => <Row key={message.id} message={message} />)}
            </DisclosureAnchorContext.Provider>
          </TranscriptDisclosureProvider>
        </div>
      </div>
    </div>
  </div>;
}

declare global { var transcriptReadingPositionProbe: () => Promise<unknown>; }
globalThis.transcriptReadingPositionProbe = async () => {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  const root = createRoot(host);
  let panes: RetainedPanes = { retainedSessionIds: [], retainedTranscripts: {} };
  let running = false;
  const select = (id: string) => {
    panes = retainSessionPane(panes, id, messages);
    flushSync(() => root.render(<>{panes.retainedSessionIds.map((held) =>
      <Pane key={held} id={held} visible={held === id} running={running && held === id} />)}</>));
  };
  const scroller = (id: string) => host.querySelector(`[data-pane="${id}"]`)!.firstElementChild!
    .firstElementChild as HTMLDivElement;
  const bottom = (el: HTMLDivElement) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2;
  try {
    select("A");
    await until(() => scroller("A").scrollHeight > 2000 && bottom(scroller("A")), "cold open follows latest");
    const a = scroller("A");
    a.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    a.scrollTop = 650;
    a.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const row = a.querySelector<HTMLElement>('[data-message-id="m47"]');
    assert(row, "reading row exists");
    select("B");
    await frame();
    select("A");
    assert(Math.abs(a.scrollTop - 650) < 2, `warm return lost offset: ${a.scrollTop}`);
    flushSync(() => row.querySelector<HTMLButtonElement>("button")!.click());
    await frame();
    a.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    a.scrollTop = 1100;
    a.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const offset = row.getBoundingClientRect().top - a.getBoundingClientRect().top;
    select("B"); select("C"); select("D"); select("E");
    assert(!host.querySelector('[data-pane="A"]'), "A must really unmount");
    assert(host.querySelectorAll("[data-pane]").length === 3, "pane retention remains bounded");
    select("A");
    const restored = scroller("A");
    await until(() => Boolean(restored.querySelector('[data-message-id="m47"]')), "reading row remounts");
    await frame();
    const restoredRow = restored.querySelector<HTMLElement>('[data-message-id="m47"]')!;
    const restoredOffset = restoredRow.getBoundingClientRect().top - restored.getBoundingClientRect().top;
    assert(Math.abs(restoredOffset - offset) < 2,
      `evicted return lost reading row offset: ${restoredOffset} vs ${offset}`);
    assert(restoredRow.querySelector('[data-expanded="true"]'), "explicit expansion was lost on eviction");
    restored.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    restored.scrollTop = 1200;
    restored.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    assert(Math.abs(restored.scrollTop - 1200) < 2, "restoration stole the viewport back from real input");
    running = true;
    select("A");
    await until(() => bottom(restored), "starting a turn resumes follow");
    select("B"); select("C"); select("D"); select("E");
    running = false;
    select("A");
    await until(() => bottom(scroller("A")), "pinned revisit follows latest");
    sessionReadingState("G").position = {
      pinned: false, messageId: "m10", offset: 24, scrollTop: 650, windowSize: 60,
    };
    select("G");
    await until(() => finishDeferredRestore !== undefined, "historical restore lookup starts");
    const deferredScroller = scroller("G");
    assert(!deferredScroller.querySelector('[data-message-id="m10"]'),
      "the deferred restore anchor must be outside the mounted window");
    const initialTop = deferredScroller.scrollTop;
    for (let frameIndex = 0; frameIndex < 3; frameIndex++) await frame();
    assert(Math.abs(deferredScroller.scrollTop - initialTop) < 2,
      "the saved offset must wait until the restore lookup completes");
    assert(!deferredRestoreAborted, "the alignment deadline must not abort a pending history lookup");
    finishDeferredRestore(true);
    finishDeferredRestore = undefined;
    await until(() => Math.abs(deferredScroller.scrollTop - 650) < 2,
      "the saved offset applies after a successful restore lookup");
    return { ok: true, warmOffset: 650, restoredOffset, panes: host.querySelectorAll("[data-pane]").length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error) };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
};
