import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { UiMessage } from "@pi-desktop/shared";
import { useTranscriptContinuation } from "../../apps/desktop/src/hooks/use-transcript-continuation";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const page = (count: number): UiMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `continuation-${index}`, role: "user", content: `Row ${index}`, createdAt: "2026-09-13T00:00:00Z",
}));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
function Surface(props: {
  enabled: boolean; loading: boolean; messages: UiMessage[]; onLoadNewer: () => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useTranscriptContinuation({ ...props, cursor: props.messages.length, scrollRef, contentRef });
  return <div ref={scrollRef} style={{ height: 200, overflowY: "auto", overflowAnchor: "none" }}>
    <div ref={contentRef}>{props.messages.map((row) => <div key={row.id} style={{ height: 100 }}>{row.content}</div>)}</div>
  </div>;
}

declare global { var transcriptContinuationProbe: () => Promise<unknown>; }
globalThis.transcriptContinuationProbe = async () => {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  const onLoadNewer = async () => { calls++; };
  let props = { enabled: false, loading: false, messages: page(10), onLoadNewer };
  const render = (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch };
    flushSync(() => root.render(<Surface {...props} />));
  };
  const scroll = () => host.firstElementChild as HTMLDivElement;
  const atBoundary = () => {
    scroll().scrollTop = scroll().scrollHeight - scroll().clientHeight;
    scroll().dispatchEvent(new Event("scroll"));
  };
  try {
    render();
    atBoundary();
    await frame();
    assert(calls === 0, "hidden/search panes must not continue");
    scroll().scrollTop = 0;
    render({ enabled: true });
    await frame();
    assert(calls === 0, "restoring a distant anchor must not drain all later history");
    atBoundary();
    for (let i = 0; i < 4; i++) scroll().dispatchEvent(new Event("scroll"));
    assert(Number(calls) === 1, "one boundary request must coalesce scroll and resize events");
    // The service reports an IO failure and clears loading without new rows.
    render({ loading: true });
    render({ loading: false });
    await frame();
    await frame();
    assert(Number(calls) === 1, "loading/resize changes must not loop after a failed page");
    scroll().dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
    scroll().scrollTop -= 10;
    scroll().dispatchEvent(new Event("scroll"));
    assert(Number(calls) === 2, "a subsequent scroll must allow retrying a failed read");
    const top = scroll().scrollTop;
    render({ messages: page(20) });
    await frame();
    assert(scroll().scrollTop === top, "appending rows must preserve the current scroll offset");
    assert(Number(calls) === 2, "a viewport no longer near the boundary must stop fetching");
    scroll().scrollTop = 0;
    render({ messages: page(1) });
    await frame();
    assert(Number(calls) === 3, "a short range must fill the viewport without a native scroll");
    render({ messages: page(1) });
    await frame();
    assert(Number(calls) === 3, "an empty/non-advancing page must not loop on a new message array");
    render({ enabled: false, messages: page(2) });
    atBoundary();
    await frame();
    assert(Number(calls) === 3, "hiding a pane must stop follow-up requests");
    const detached = scroll();
    flushSync(() => root.unmount());
    detached.dispatchEvent(new Event("scroll"));
    await frame();
    assert(Number(calls) === 3, "unmount must release continuation listeners");
    return { ok: true, requests: calls };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), requests: calls };
  } finally {
    root.unmount();
    host.remove();
  }
};
