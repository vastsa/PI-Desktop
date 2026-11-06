import "./transcript-history-navigation";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { Button } from "../../apps/desktop/src/components/ui";

const manual = new URLSearchParams(location.search).has("manual");
let firstMessage = manual ? 960 : 60;
let manualStatus = "Scroll upward to request history. No real sessions or providers are used.";
function showStatus(message: string) {
  manualStatus = message;
  const output = document.getElementById("history-manual-status");
  if (output) output.textContent = message;
}
async function manualAction(action: () => Promise<unknown>) {
  try { await action(); }
  catch (error) { showStatus(error instanceof Error ? error.message : String(error)); }
}

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
let layoutSamples: number[] = [];
let sampling = 0;
let scenario = 0;
let nativeInputEnded = false;
function armNativeInput() {
  nativeInputEnded = false;
  scroller().addEventListener("scrollend", () => { nativeInputEnded = true; }, { once: true });
}
async function finishNativeInput() {
  await until(() => nativeInputEnded, "native wheel did not finish");
  return inspect();
}
const scroller = () => host.querySelector<HTMLElement>(".thread-scroll")!;
const busy = () => host.querySelector('.transcript-history-loading[aria-hidden="false"]') !== null;
const offset = () => anchor!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
const onLoadOlder = () => new Promise<void>((resolve, reject) => {
  calls++; finish = resolve; fail = () => reject(new Error("Synthetic history read failed"));
  showStatus(`Request ${calls} pending; ${current.length} messages loaded. Keep scrolling, then complete or fail this page.`);
});
function render() {
  flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <nav style={{ display: "flex", gap: 12, padding: 8 }}>
      <Button onClick={() => void manualAction(reset)}>Reset conversation</Button>
      <Button onClick={() => void manualAction(manual ? requestManualPage : () => begin())}>Load earlier (hold)</Button>
      <Button onClick={() => void manualAction(() => release())}>Complete page</Button>
      <Button onClick={() => void manualAction(() => release(true))}>Fail page</Button>
      <span>Keep scrolling during loading; releasing a page must not reverse your movement.</span>
    </nav>
    {manual ? <output id="history-manual-status" aria-live="polite" style={{ padding: 8 }}>{manualStatus}</output> : null}
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, position: "relative", visibility: visible ? "visible" : "hidden" }}>
      <ChatTranscript key={scenario} sessionId={`history-loading-${scenario}`} messages={current}
        hasMoreBefore={more} onLoadOlder={onLoadOlder} isRunning={false} paneVisible={visible} />
    </div>
  </I18nextProvider>));
}
async function reset() {
  finish?.(); finish = undefined;
  scenario++; calls = 0; more = true; visible = true;
  firstMessage = manual ? 960 : 60;
  current = messages(firstMessage, manual ? 1000 : 100);
  showStatus(`Ready: ${current.length} of ${manual ? 1000 : 100} synthetic messages loaded. Scroll upward to request a page.`);
  anchor = undefined; cancelAnimationFrame(sampling); samples = [];
  render();
  await until(() => !host.querySelector('[data-transcript-settling="true"]'), "first paint did not settle");
  await frame(); await frame();
}
async function begin(top = 80) {
  const el = scroller();
  // Enter from the user's ordinary scroll route; native wheel is exercised by
  // the Electron driver while the real asynchronous page is held below.
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  el.scrollTo({ top, behavior: "instant" });
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  await until(busy, "page did not start");
  return track();
}
async function requestManualPage() {
  const currentScenario = scenario;
  for (let attempt = 0; attempt < 30 && !finish && more && scenario === currentScenario; attempt++) {
    const el = scroller();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    el.scrollTo({ top: 80, behavior: "instant" });
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    // Cached-window expansion settles independently of physical page loading.
    let stable = 0;
    let height = el.scrollHeight;
    while (stable < 3 && !finish && scenario === currentScenario) {
      await frame();
      const next = el.scrollHeight;
      stable = next === height ? stable + 1 : 0;
      height = next;
    }
  }
  if (scenario !== currentScenario) return;
  if (finish) track();
  else showStatus(more ? "Continue scrolling upward to request history." : "All synthetic history has been reached.");
}
const beginAhead = () => begin(scroller().clientHeight * 2);
async function release(failed = false, lateLayout = false, empty = false) {
  if (!finish) throw new Error("No pending page");
  const resolve = finish; finish = undefined;
  if (!failed && !empty) {
    const start = manual ? Math.max(0, firstMessage - 100) : 0;
    current = [...messages(start, firstMessage), ...current];
    firstMessage = start; more = start > 0; render();
  }
  showStatus(failed ? "Simulated page failure. Scroll upward again to retry." :
    `Page complete: ${current.length} messages loaded; ${firstMessage} older messages remain unloaded.`);
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
    layoutSampleCount: layoutSamples.length,
    layoutMaxDrift: layoutSamples.length ? Math.max(...layoutSamples.map(x => Math.abs(x - baseline))) : 0,
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
  await until(() => layoutSamples.length > 0, "revealed history did not produce a layout sample");
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
  await until(() => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2, "latest navigation did not arrive");
  return { ...inspect(), distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop };
}
function track(readingNode?: HTMLElement) {
  cancelAnimationFrame(sampling);
  const el = scroller();
  anchor = readingNode ?? [...el.querySelectorAll<HTMLElement>("[data-minimap-id]")].find(row => {
    const r = row.getBoundingClientRect(); return r.bottom > el.getBoundingClientRect().top && r.height > 0;
  });
  if (!anchor) throw new Error("Missing visible reading anchor");
  baseline = offset(); samples = []; layoutSamples = [];
  const tracked = anchor;
  const sample = () => {
    if (visible) samples.push(offset());
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      if (visible && anchor === tracked) layoutSamples.push(offset());
    });
    observer.observe(el);
    sampling = requestAnimationFrame(sample);
  };
  sampling = requestAnimationFrame(sample);
  return inspect();
}
async function crossAhead() {
  const el = scroller();
  for (const row of el.querySelectorAll<HTMLElement>("[data-message-id], [data-minimap-id]")) row.style.contentVisibility = "visible";
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
  el.scrollTo({ top: el.clientHeight * 3 + 400, behavior: "instant" });
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  await frame(); await frame();
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
  el.scrollTo({ top: el.clientHeight, behavior: "smooth" });
  await until(() => calls === 1, "smooth upward travel did not prefetch");
  await until(() => Math.abs(el.scrollTop - el.clientHeight) <= 2, "prefetch interrupted browser smooth upward travel");
  return track();
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
let mutateSettledLayout: (amount: number) => void = () => { throw new Error("No prepared layout case"); };
async function prepareSettledLayout(kind: "late" | "balanced" | "paragraph") {
  await reset(); await beginAhead(); await release();
  const el = scroller();
  if (kind === "paragraph") {
    const id = current.at(-3)!.id;
    current = current.map(message => message.id === id ? { ...message,
      content: Array.from({ length: 40 }, (_, n) => `Paragraph ${n}. ${"Stable long-answer reading content. ".repeat(12)}`).join("\n\n") } : message);
    render();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
  const rows = [...el.querySelectorAll<HTMLElement>("[data-message-id], [data-minimap-id]")];
  for (const row of rows) row.style.contentVisibility = "visible";
  const below = rows.at(-1)!;
  below.style.paddingBottom = "120px";
  for (let n = 0; n < 8; n++) await frame();
  const paragraphs = [...el.querySelectorAll<HTMLElement>(`[data-message-id="${current.at(-3)!.id}"] .prose-chat p`)];
  const paragraph = kind === "paragraph" ? paragraphs[20] : undefined;
  if (kind === "paragraph" && !paragraph) throw new Error("Long-answer paragraph missing");
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  el.scrollTo({ top: paragraph ? el.scrollTop + paragraph.getBoundingClientRect().top - el.getBoundingClientRect().top - 120 : el.scrollHeight / 2,
    behavior: "instant" });
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  for (let n = 0; n < 12; n++) await frame();
  const before = track(paragraph);
  const above = kind === "paragraph" ? paragraphs[0] : rows.find(row => row.getBoundingClientRect().bottom < el.getBoundingClientRect().top);
  if (!above || above === below) throw new Error("Need distinct content above/below the reading point");
  const padding = parseFloat(getComputedStyle(above).paddingBottom);
  const height = el.scrollHeight;
  mutateSettledLayout = amount => {
    above.style.paddingBottom = `${padding + amount}px`;
    if (kind === "balanced") below.style.paddingBottom = `${120 - amount}px`;
  };
  const viewport = el.getBoundingClientRect();
  let line: DOMRect | undefined;
  for (const node of el.querySelectorAll(".prose-chat p, .message-user-text")) {
    const range = document.createRange(); range.selectNodeContents(node);
    line = [...range.getClientRects()].find(rect => rect.width > 200 && rect.top > viewport.top + 20 && rect.bottom < viewport.bottom - 20);
    if (line) break;
  }
  if (!line) throw new Error("Need a visible text line for painted-pixel comparison");
  return { kind, before, height, crop: { x: Math.ceil(line.left), y: Math.ceil(line.top), width: 200, height: 12 } };
}
async function settledLayout(kind: "late" | "balanced" | "paragraph") {
  const prepared = await prepareSettledLayout(kind);
  mutateSettledLayout(120);
  for (let n = 0; n < 12; n++) await frame();
  cancelAnimationFrame(sampling);
  return { ...prepared, after: inspect(), totalDelta: scroller().scrollHeight - prepared.height };
}
declare global { var historyLoadingFixture: { reset: typeof reset; begin: typeof begin; release: typeof release;
  inspect: typeof inspect; growTail: typeof growTail; hideAndReveal: typeof hideAndReveal;
  inputOwnership: typeof inputOwnership; jumpWhileLoading: typeof jumpWhileLoading; beginAhead: typeof beginAhead; track: typeof track;
  growMountedWindow: typeof growMountedWindow; crossAhead: typeof crossAhead; armNativeInput: typeof armNativeInput;
  settledLayout: typeof settledLayout; prepareSettledLayout: typeof prepareSettledLayout; mutateSettledLayout: (amount: number) => void;
  finishNativeInput: typeof finishNativeInput; frames: () => Promise<void> }; }
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
useAppStore.setState({ activeSessionId: "history-fixture", messages: [], sessions: [], runningSessions: {},
  pendingPlans: {}, pendingAsks: {}, pendingPermissions: {}, planningStates: {}, latestTurnResults: {},
  settings: { ...useAppStore.getState().settings, smoothStreaming: false } });
globalThis.historyLoadingFixture = { reset, begin, beginAhead, track, release, inspect, growTail, hideAndReveal, inputOwnership, jumpWhileLoading, growMountedWindow, crossAhead, armNativeInput, finishNativeInput, settledLayout,
  prepareSettledLayout, mutateSettledLayout: amount => mutateSettledLayout(amount),
  frames: async () => { for (let n = 0; n < 4; n++) await frame(); } };
await reset();
