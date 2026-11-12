import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { useTranscriptHistoryPaging } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptHistoryPaging";

const host = document.createElement("div");
document.body.append(host);
const style = document.createElement("style");
style.textContent = "body{margin:0} .prose-chat p{margin:0;height:100px;line-height:20px} .prose-chat p:first-child{padding-bottom:var(--growth,0px)}";
document.head.append(style);
const root = createRoot(host);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function frames() { for (let n = 0; n < 8; n++) await frame(); }
let serial = 0;
let beforeHeight = 900;
let growth = 0;
let revision = 0;
let clampWitness = 0;
let api: ReturnType<typeof useTranscriptHistoryPaging>;
const source = "Earlier paragraph with unchanged source.\n\nReading paragraph with **stable inline text**.\n\nLast paragraph.";
function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Observe actual browser clamping before the production layout effect repairs it.
  useLayoutEffect(() => { clampWitness = scrollRef.current!.scrollTop; });
  api = useTranscriptHistoryPaging({ scrollRef, contentRef, visible: true, sourceHead: "before",
    canRetain: () => true, onStart: () => {}, onPosition: () => {}, onSettled: () => {} });
  return <div ref={scrollRef} onScroll={() => api.track()} data-scroller="" style={{ height: 500, width: 600, overflow: "auto", overflowAnchor: "none" }}>
    <div ref={contentRef}>
      <div style={{ height: beforeHeight }} />
      <div data-message-id="reading" className="prose-chat" style={{ "--growth": `${growth}px` } as React.CSSProperties}>
        <Markdown key={revision} source={source} />
      </div>
      <div style={{ height: beforeHeight === 200 ? 600 : 300 }} />
    </div>
  </div>;
}
function render() { flushSync(() => root.render(<Fixture key={serial} />)); }
const scroller = () => host.querySelector<HTMLDivElement>("[data-scroller]")!;
const paragraph = (n: number) => host.querySelectorAll<HTMLElement>(".prose-chat p")[n];
const offset = (n: number) => paragraph(n).getBoundingClientRect().top - scroller().getBoundingClientRect().top;
async function prepare(pre: number, top: number) {
  console.log("ANCHOR_PREPARE", pre, top);
  serial++; beforeHeight = pre; growth = 0; revision = 0; render(); await frames();
  scroller().scrollTop = top;
  scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
  api.run(() => Promise.resolve(), 60, true);
  await frames();
}
async function probe() {
  const results = [];
  for (const kind of ["ordinary-shrink", "browser-clamp", "paragraph-remount", "reader-scroll"] as const) {
    console.log("ANCHOR_CASE", kind);
    const remount = kind === "paragraph-remount";
    await prepare(remount ? 200 : 900, remount ? 320 : 800);
    const index = remount ? 1 : 0;
    const baseline = offset(index);
    const oldNode = paragraph(index);
    const oldTop = scroller().scrollTop;
    const oldHeight = scroller().scrollHeight;
    if (remount) { growth = 80; revision++; }
    else if (kind === "reader-scroll") scroller().scrollTop += 40;
    else beforeHeight -= kind === "browser-clamp" ? 500 : 100;
    render();
    const clamped = clampWitness;
    await frames();
    const expected = baseline - (kind === "reader-scroll" ? 40 : 0);
    results.push({ kind, baseline, expected, actual: offset(index), drift: Math.abs(offset(index) - expected),
      oldTop, clamped, top: scroller().scrollTop, oldHeight, height: scroller().scrollHeight,
      replaced: oldNode !== paragraph(index), connected: oldNode.isConnected });
  }
  return results;
}
declare global { var transcriptAnchorRepairProbe: typeof probe; }
globalThis.transcriptAnchorRepairProbe = probe;
await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: {} } } });
