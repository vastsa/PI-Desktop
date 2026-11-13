import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { useTranscriptHistoryPaging } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptHistoryPaging";
import { captureTranscriptTextAnchor, resolveTranscriptTextAnchor } from "../../apps/desktop/src/lib/transcript-reading-anchor";

const host = document.createElement("div");
document.body.append(host);
const style = document.createElement("style");
style.textContent = "body{margin:0} .prose-chat p{margin:0;height:100px;line-height:20px} .prose-chat.long p{height:auto} .prose-chat p:first-child{padding-bottom:var(--growth,0px)}";
document.head.append(style);
const root = createRoot(host);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function frames() { for (let n = 0; n < 8; n++) await frame(); }
let serial = 0;
let beforeHeight = 900;
let tailHeight = 300;
let width = 600;
let growth = 0;
let revision = 0;
let long = false;
let clampWitness = 0;
let scrollWrites = 0;
let nativeLayout = false;
let nativeEnded = false;
const observerWarnings: string[] = [];
let stage = "initial";
window.addEventListener("error", event => {
  if (event.message.includes("ResizeObserver loop")) observerWarnings.push(stage);
});
let api: ReturnType<typeof useTranscriptHistoryPaging>;
const source = "Earlier paragraph with unchanged source.\n\nReading paragraph with **stable inline text**.\n\nLast paragraph.";
const longSource = "Long paragraph with **inline emphasis** and stable characters. ".repeat(140);
function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current!;
    // Pass-through write spy: every value and geometry still comes from Chromium.
    if (!Object.hasOwn(element, "scrollTop")) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      Object.defineProperty(element, "scrollTop", { configurable: true,
        get: () => descriptor.get!.call(element),
        set: (value: number) => { scrollWrites++; descriptor.set!.call(element, value); } });
    }
    clampWitness = element.scrollTop;
  });
  api = useTranscriptHistoryPaging({ scrollRef, contentRef, visible: true, sourceHead: "before",
    canRetain: () => true, onStart: () => {}, onPosition: () => {}, onSettled: () => {} });
  return <div ref={scrollRef} onScroll={() => { nativeEnded = false; api.track(); }} onWheel={() => {
    if (nativeLayout) {
      nativeLayout = false;
      beforeHeight = 400;
      contentRef.current!.firstElementChild!.setAttribute("style", "height:400px");
      clampWitness = scrollRef.current!.scrollTop;
    }
    api.restore();
  }} data-scroller="" style={{ height: 500, width, overflow: "auto", overflowAnchor: "none" }}>
    <div ref={contentRef}>
      <div style={{ height: beforeHeight }} />
      <div data-message-id="reading" className={`prose-chat${long ? " long" : ""}`} style={{ "--growth": `${growth}px` } as CSSProperties}>
        <Markdown key={revision} source={long ? longSource : source} />
      </div>
      <div style={{ height: tailHeight }} />
    </div>
  </div>;
}
function render() { flushSync(() => root.render(<Fixture key={serial} />)); }
const scroller = () => host.querySelector<HTMLDivElement>("[data-scroller]")!;
const row = () => host.querySelector<HTMLElement>('[data-message-id="reading"]')!;
const paragraph = (n: number) => host.querySelectorAll<HTMLElement>(".prose-chat p")[n];
const offset = (n: number) => paragraph(n).getBoundingClientRect().top - scroller().getBoundingClientRect().top;
async function prepare(pre: number, top: number, longText = false) {
  serial++; beforeHeight = pre; tailHeight = pre === 200 ? 600 : 300;
  width = 600; growth = 0; revision = 0; long = longText; nativeLayout = false;
  render(); await frames();
  scroller().scrollTop = top;
  scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
  api.run(() => Promise.resolve(), 60, true);
  await frames();
}
function crop() {
  const viewport = scroller().getBoundingClientRect();
  for (const p of row().querySelectorAll("p")) {
    const range = document.createRange(); range.selectNodeContents(p);
    const rect = [...range.getClientRects()].find(rect => rect.width > 90 && rect.top > viewport.top + 20 && rect.bottom < viewport.bottom - 20);
    if (rect) return { x: Math.ceil(rect.left + 2), y: Math.ceil(rect.top), width: 80, height: 12 };
  }
  throw new Error("No actual text crop");
}
async function afterLayout() {
  await new Promise<void>(resolve => {
    const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(scroller().firstElementChild!);
  });
}
async function samples(read: () => number, expected: number) {
  const offsets = [];
  for (let n = 0; n < 8; n++) { await frame(); await afterLayout(); offsets.push(read()); }
  return { samples: offsets.length, maxFrameDrift: Math.max(...offsets.map(value => Math.abs(value - expected))) };
}
type Kind = "ordinary-shrink" | "browser-clamp" | "paragraph-remount" | "balanced-remount" | "reader-scroll" | "unreachable";
let prepared: { kind: Kind; baseline: number; index: number; oldNode: HTMLElement; oldTop: number; oldHeight: number };
async function prepareCase(kind: Kind) {
  const remount = kind.includes("remount");
  stage = kind;
  await prepare(remount ? 200 : 900, remount ? 320 : 800);
  const index = remount ? 1 : 0;
  prepared = { kind, baseline: offset(index), index, oldNode: paragraph(index), oldTop: scroller().scrollTop, oldHeight: scroller().scrollHeight };
  return { crop: crop() };
}
async function mutateCase(injectDrift = false) {
  const { kind, baseline, index, oldNode, oldTop, oldHeight } = prepared;
  if (kind.includes("remount")) { growth = 80; revision++; if (kind === "balanced-remount") tailHeight -= 80; }
  else if (kind === "reader-scroll") scroller().scrollTop += 40;
  else beforeHeight -= kind === "browser-clamp" ? 500 : kind === "unreachable" ? 900 : 100;
  render();
  const clamped = clampWitness;
  const expected = baseline - (kind === "reader-scroll" ? 40 : kind === "unreachable" ? 100 : 0);
  const sampling = await samples(() => offset(index), expected);
  const writesBefore = scrollWrites;
  for (let n = 0; n < 4; n++) api.restore();
  if (injectDrift) { paragraph(index).style.transform = "translateY(20px)"; await frames(); }
  return { kind, baseline, expected, actual: offset(index), drift: Math.abs(offset(index) - expected), ...sampling,
    oldTop, clamped, top: scroller().scrollTop, oldHeight, height: scroller().scrollHeight,
    repeatedWrites: scrollWrites - writesBefore, replaced: oldNode !== paragraph(index), connected: oldNode.isConnected };
}
// Independent oracle walks the known character offset without re-resolving the
// production descriptor. This catches block-only anchoring during line reflow.
function characterOffset(character: number) {
  const walker = document.createTreeWalker(paragraph(0), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (character < length) {
      const range = document.createRange(); range.setStart(node, character); range.setEnd(node, character + 1);
      return range.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    }
    character -= length;
  }
  throw new Error("Oracle character missing");
}
async function textContracts() {
  stage = "text-contracts";
  await prepare(200, 700, true);
  const point = captureTranscriptTextAnchor(scroller(), row())!;
  if (!point.textOffset || point.sourceStart === undefined) throw new Error("Need a source-owned intra-paragraph character");
  const baseline = characterOffset(point.textOffset);
  const oldNode = point.element;
  width = 510; revision++; render();
  const sampling = await samples(() => characterOffset(point.textOffset!), baseline);
  const actual = characterOffset(point.textOffset);
  const resolved = resolveTranscriptTextAnchor(row(), point);
  // Same length and parser range, different text: a source range alone is unsafe.
  stage = "edited-content";
  paragraph(0).firstChild!.textContent = paragraph(0).firstChild!.textContent!.replace("Long", "Edit");
  const rejectedEdit = resolveTranscriptTextAnchor(row(), point) === undefined;
  api.restore();
  await frames();
  const editedTop = scroller().scrollTop;
  stage = "missing-content";
  row().replaceChildren();
  const rejectedMissing = resolveTranscriptTextAnchor(row(), point) === undefined;
  api.restore();
  await frames();
  const warningsBefore = observerWarnings.length;
  const writesBefore = scrollWrites;
  for (let n = 0; n < 4; n++) api.restore();
  await frames();
  const fallbackStable = observerWarnings.length === warningsBefore && scrollWrites === writesBefore;
  return { character: point.textOffset, baseline, actual, drift: Math.abs(actual - baseline), ...sampling,
    reconstructed: !oldNode.isConnected, resolved: Boolean(resolved), rejectedEdit, rejectedMissing,
    fallbackLegal: editedTop >= 0 && scroller().scrollTop >= 0, fallbackStable };
}
async function prepareNative(withLayout = true) {
  stage = withLayout ? "native-clamp" : "native-control";
  await prepare(withLayout ? 900 : 400, withLayout ? 800 : 300);
  nativeLayout = withLayout; nativeEnded = false;
  scroller().addEventListener("scrollend", () => { nativeEnded = true; });
  const rect = scroller().getBoundingClientRect();
  return { baseline: offset(0), x: Math.round(rect.left + 200), y: Math.round(rect.top + 200) };
}
async function nativeResult() {
  // An instant repair may emit an earlier scrollend; a later scroll invalidates
  // it. Wait for the final native end, not a fixed animation duration.
  const end = performance.now() + 6000;
  do {
    if (performance.now() > end) throw new Error("Native input did not settle");
    await frames();
  } while (!nativeEnded);
  return { actual: offset(0), top: scroller().scrollTop, clamped: clampWitness, nativeLayout, observerWarnings: [...observerWarnings] };
}
const fixture = { prepareCase, mutateCase, textContracts, prepareNative, nativeResult, frames };
declare global { var transcriptAnchorRepairFixture: typeof fixture; }
await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: {} } } });
globalThis.transcriptAnchorRepairFixture = fixture;
