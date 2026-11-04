import "./transcript-history-navigation";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(test: () => boolean, label: string) {
  const deadline = performance.now() + 6000;
  while (!test()) {
    if (performance.now() > deadline) throw new Error(`History loading: ${label}`);
    await frame();
  }
}
const messages = (start: number, end: number): UiMessage[] => Array.from({ length: end - start }, (_, n) => ({
  id: `history-${start + n}`, role: n % 2 ? "assistant" : "user", status: "complete",
  createdAt: "2026-11-01T00:00:00Z",
  content: `Turn ${start + n}\n\n${"Reading anchor content. ".repeat(35)}`,
}));
const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
document.body.append(host);
const root = createRoot(host);
let current = messages(60, 100);
let visible = true;
let more = true;
let calls = 0;
let finish: (() => void) | undefined;
let fail: (() => void) | undefined;
let anchor: HTMLElement | undefined;
let baseline = 0;
let samples: number[] = [];
let sampling = 0;
let scenario = 0;
const scroller = () => host.querySelector<HTMLElement>(".thread-scroll")!;
const busy = () => host.querySelector('.transcript-history-loading[aria-hidden="false"]') !== null;
const offset = () => anchor!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
const onLoadOlder = () => new Promise<void>((resolve, reject) => {
  calls++; finish = resolve; fail = () => reject(new Error("Synthetic history read failed"));
});
function render() {
  flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <nav style={{ display: "flex", gap: 12, padding: 8 }}>
      <button onClick={() => void reset()}>Reset conversation</button>
      <button onClick={() => void begin()}>Load earlier (hold)</button>
      <button onClick={() => void release()}>Complete page</button>
      <button onClick={() => void release(true)}>Fail page</button>
      <span>Scroll continuously while loading; the visible turn must stay still.</span>
    </nav>
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, position: "relative", visibility: visible ? "visible" : "hidden" }}>
      <ChatTranscript key={scenario} sessionId={`history-loading-${scenario}`} messages={current}
        hasMoreBefore={more} onLoadOlder={onLoadOlder} isRunning={false} paneVisible={visible} />
    </div>
  </I18nextProvider>));
}
async function reset() {
  finish?.(); finish = undefined;
  scenario++; calls = 0; more = true; visible = true; current = messages(60, 100);
  anchor = undefined; cancelAnimationFrame(sampling); samples = [];
  render();
  await until(() => !host.querySelector('[data-transcript-settling="true"]'), "first paint did not settle");
  await frame(); await frame();
}
async function begin() {
  const el = scroller();
  // Enter from the user's ordinary scroll route; native wheel is exercised by
  // the Electron driver while the real asynchronous page is held below.
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  el.scrollTo({ top: 80, behavior: "instant" });
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  await until(busy, "page did not start");
  return track();
}
async function release(failed = false, lateLayout = false, empty = false) {
  if (!finish) throw new Error("No pending page");
  const resolve = finish; finish = undefined;
  if (!failed && !empty) { current = [...messages(0, 60), ...current]; more = false; render(); }
  if (failed) fail?.(); else resolve();
  fail = undefined;
  if (lateLayout) {
    const row = scroller().querySelector<HTMLElement>("[data-minimap-id]")!;
    row.style.contentVisibility = "visible";
    for (let n = 1; n <= 6; n++) { await frame(); row.style.paddingBottom = `${n * 20}px`; }
  }
  await until(() => !busy(), "loading did not finish");
  // Include multiple paints and lazy content-visibility layout after prepend.
  for (let n = 0; n < 12; n++) await frame();
  cancelAnimationFrame(sampling);
  return inspect();
}
function inspect() {
  const el = scroller(); const r = el.getBoundingClientRect();
  const probe = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 0 });
  el.dispatchEvent(probe);
  return { busy: busy(), locked: probe.defaultPrevented, calls, top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, anchorId: anchor?.dataset.minimapId,
    offset: anchor ? offset() : null, baseline, maxDrift: samples.length ? Math.max(...samples.map(x => Math.abs(x - baseline))) : 0,
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(180, r.height / 2)) };
}
async function growTail() {
  current = [...current, ...messages(100, 104)]; render();
  for (let n = 0; n < 4; n++) await frame();
  return inspect();
}
async function hideAndReveal() {
  visible = false; render(); await frame();
  finish?.(); finish = undefined;
  visible = true; render();
  await until(() => !busy(), "hidden load did not release");
  return inspect();
}
function inputOwnership() {
  const el = scroller();
  const field = document.createElement("textarea");
  const title = document.createElement("button");
  const nested = document.createElement("div");
  nested.dataset.scrollOwner = "fixture-dock";
  nested.style.cssText = "height:40px;overflow:auto";
  nested.innerHTML = '<div style="height:400px">Nested scroll content</div>';
  el.append(field, title, nested);
  const blocked = (target: HTMLElement, event: Event) => { target.dispatchEvent(event); return event.defaultPrevented; };
  const key = (value: string) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value });
  const wheel = (ctrlKey = false) => new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, ctrlKey });
  try {
    return { wheel: blocked(el, wheel()), key: blocked(el, key("PageUp")),
      touch: blocked(el, new Event("touchmove", { bubbles: true, cancelable: true })),
      field: blocked(field, key("ArrowUp")), activation: blocked(title, key(" ")),
      nested: blocked(nested, wheel()), zoom: blocked(el, wheel(true)) };
  } finally { field.remove(); title.remove(); nested.remove(); }
}
async function jumpWhileLoading() {
  host.querySelector<HTMLButtonElement>(".jump-latest-btn")!.click();
  await frame();
  await release();
  const el = scroller();
  return { ...inspect(), distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop };
}
function track() {
  cancelAnimationFrame(sampling);
  const el = scroller();
  anchor = [...el.querySelectorAll<HTMLElement>("[data-minimap-id]")].find(row => {
    const r = row.getBoundingClientRect(); return r.bottom > el.getBoundingClientRect().top && r.height > 0;
  });
  if (!anchor) throw new Error("Missing visible reading anchor");
  baseline = offset(); samples = [];
  const sample = () => { if (visible) samples.push(offset()); sampling = requestAnimationFrame(sample); };
  sampling = requestAnimationFrame(sample);
  return inspect();
}
async function growMountedWindow() {
  const el = scroller();
  const count = el.querySelectorAll("[data-minimap-id]").length;
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  el.scrollTo({ top: 80, behavior: "instant" });
  const before = track();
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  await until(() => el.querySelectorAll("[data-minimap-id]").length > count, "cached history did not mount");
  for (let n = 0; n < 12; n++) await frame();
  cancelAnimationFrame(sampling);
  return { before, after: inspect() };
}
declare global { var historyLoadingFixture: { reset: typeof reset; begin: typeof begin; release: typeof release;
  inspect: typeof inspect; growTail: typeof growTail; hideAndReveal: typeof hideAndReveal;
  inputOwnership: typeof inputOwnership; jumpWhileLoading: typeof jumpWhileLoading;
  growMountedWindow: typeof growMountedWindow; frames: () => Promise<void> }; }
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
useAppStore.setState({ activeSessionId: "history-fixture", messages: [], sessions: [], runningSessions: {},
  pendingPlans: {}, pendingAsks: {}, pendingPermissions: {}, planningStates: {}, latestTurnResults: {},
  settings: { ...useAppStore.getState().settings, smoothStreaming: false } });
globalThis.historyLoadingFixture = { reset, begin, release, inspect, growTail, hideAndReveal, inputOwnership, jumpWhileLoading, growMountedWindow,
  frames: async () => { for (let n = 0; n < 4; n++) await frame(); } };
await reset();
