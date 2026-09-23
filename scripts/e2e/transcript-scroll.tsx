import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { verifyShortSessionEntry } from "./transcript-entry";
import { verifyRetainedPage } from "./transcript-retained-page";
import { verifyDisclosureDuringPage } from "./transcript-disclosure-page";
import { verifyTranscriptNavigation } from "./transcript-navigation";
import { verifyUnderfilledEntry } from "./transcript-underfilled-entry";

// The preload dispatches Chromium input; DOM WheelEvent does not actually scroll.
declare global {
  var scrollProbeDriver: { wheel(input: { x: number; y: number; deltaY: number }): Promise<void> };
  var transcriptScrollProbe: (scenario?: "all" | "underfilled") => Promise<unknown>;
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const createdAt = "2026-09-22T00:00:00.000Z";
function history(start: number, count: number, paragraphs = 1): UiMessage[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return [
      { id: `user-${index}`, role: "user", content: `Request ${index}`, createdAt },
      { id: `thinking-${index}`, role: "assistant", content: "", thinking: "Reasoning before the tool. ".repeat(80), createdAt },
      { id: `tool-${index}`, role: "tool", content: "done", createdAt,
        toolName: "Bash", toolCallId: `call-${index}`, toolStatus: "success",
        toolArgs: { command: "echo done" }, toolResult: { details: { stdout: "done", exitCode: 0 } } },
      { id: `answer-${index}`, role: "assistant", createdAt,
        content: Array.from({ length: paragraphs }, (_, line) => `Answer ${index}, paragraph ${line}. Folded history must keep its reading position.`).join("\n\n") },
    ] as UiMessage[];
  }).flat();
}

function scroller(host: HTMLElement) {
  const element = host.querySelector<HTMLElement>(".thread-scroll");
  if (!element) throw new Error("transcript scroller missing");
  return element;
}
function visibleRow(host: HTMLElement) {
  const viewport = scroller(host).getBoundingClientRect();
  const row = [...host.querySelectorAll<HTMLElement>(".thread-content > .message-row")].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
  });
  if (!row) throw new Error("no visible transcript row");
  return row;
}
function geometry(host: HTMLElement) {
  const el = scroller(host);
  const tail = host.querySelector<HTMLElement>(".thread-content > .message-row:last-of-type");
  return { top: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight), height: el.scrollHeight,
    tailTop: tail?.getBoundingClientRect().top ?? 0,
    rows: host.querySelectorAll(".thread-content > .message-row").length };
}
async function frames(count: number) { for (let i = 0; i < count; i++) await frame(); }
async function settled(host: HTMLElement) {
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 180; attempt++) {
    await frame();
    const current = JSON.stringify(geometry(host));
    stable = current === previous && !host.querySelector(".transcript-settle-veil") ? stable + 1 : 0;
    if (stable >= 4) return;
    previous = current;
  }
  throw new Error("transcript never settled");
}
async function wheel(host: HTMLElement, deltaY: number) {
  const rect = scroller(host).getBoundingClientRect();
  await globalThis.scrollProbeDriver.wheel({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), deltaY });
}
async function approachHistory(host: HTMLElement) {
  await wheel(host, 200 - scroller(host).scrollTop);
  await frames(12);
  if (Math.abs(scroller(host).scrollTop - 200) > 2) throw new Error("native wheel did not reach the history approach position");
}

export const probe = async (scenario: "all" | "underfilled" = "all") => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const initial = useAppStore.getState();
  useAppStore.setState({ settings: { defaultMode: "agent", theme: "light", enterToSend: true,
    onboardingDismissed: true, thinkingDisplayMode: "detailed" } });
  const failures: string[] = [];
  const reports: unknown[] = [];
  let root: Root | undefined;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;--composer-dock-height:180px";
  document.body.append(host);
  let trustedWheels = 0;
  let veilWheels = 0;
  const onWheel = (event: WheelEvent) => {
    if (event.isTrusted) {
      trustedWheels++;
      if (event.target instanceof Element && event.target.closest(".transcript-settle-veil")) veilWheels++;
    }
  };
  host.addEventListener("wheel", onWheel, { passive: true, capture: true });
  let props: { messages: UiMessage[]; hasMoreBefore?: boolean; onLoadOlder?: () => Promise<void>; paneVisible?: boolean; readingWindow?: boolean };
  let session = 0;
  function render() {
    flushSync(() => root!.render(<I18nextProvider i18n={i18n}><TranscriptDisclosureProvider>
      <div className="session-pane" data-visible={props.paneVisible === false ? "false" : "true"}>
        <ChatTranscript sessionId={`scroll-probe-${session}`} {...props} isRunning={false} />
      </div>
    </TranscriptDisclosureProvider></I18nextProvider>));
  }
  function mount(next: typeof props) {
    if (root) flushSync(() => root!.unmount());
    session++;
    root = createRoot(host);
    props = next;
    render();
  }
  try {
    if (scenario === "underfilled") {
      const result = await verifyUnderfilledEntry(i18n, history(90, 2, 5), history(70, 20, 3));
      return { ok: result.failures.length === 0, failures: result.failures, dpr: devicePixelRatio, reports: [result] };
    }
    // Record short session entry from its first commit, not after the settle veil.
    for (const count of [1, 3, 6]) {
      mount({ messages: history(0, count, 3) });
      const samples = [geometry(host)];
      for (let i = 0; i < 16; i++) { await frame(); samples.push(geometry(host)); }
      const visibleTops = samples.map((sample) => sample.tailTop);
      const range = Math.max(...visibleTops) - Math.min(...visibleTops);
      if (range > 2) failures.push(`short entry (${count} turns) moved its answer ${range}px`);
      reports.push({ name: `short-entry-${count}`, range, samples });
    }

    let finishSmallPage: (() => void) | undefined;
    let smallPageCalls = 0;
    mount({ messages: history(20, 2, 3), hasMoreBefore: true, onLoadOlder: () => {
      smallPageCalls++;
      return new Promise<void>((resolve) => { finishSmallPage = resolve; });
    } });
    await settled(host);
    const smallRow = visibleRow(host);
    const smallBefore = smallRow.getBoundingClientRect().top;
    const smallGeometry = geometry(host);
    await wheel(host, -8);
    const smallSamples = [];
    for (let i = 0; i < 16; i++) {
      await frame();
      smallSamples.push({ top: scroller(host).scrollTop, rowTop: smallRow.getBoundingClientRect().top });
    }
    const smallAfter = smallRow.getBoundingClientRect().top;
    const smallShift = Math.max(...smallSamples.map((s) => Math.abs(s.rowTop - smallBefore + s.top - smallGeometry.top)));
    if (smallShift > 2) failures.push(`first near-top wheel shifted reading row by an extra ${smallShift}px`);
    if (smallPageCalls !== 1) failures.push(`near-top wheel did not request exactly one page (${smallPageCalls})`);
    reports.push({ name: "first-near-top-wheel", smallBefore, smallAfter, smallShift, smallGeometry, smallSamples, after: geometry(host) });
    props = { ...props, hasMoreBefore: false };
    render();
    finishSmallPage?.();
    await frames(3);

    mount({ messages: history(0, 65) });
    const beforeVeilWheel = veilWheels;
    await wheel(host, -120);
    await settled(host);
    if (veilWheels === beforeVeilWheel) failures.push("entry fixture did not deliver wheel to the settle veil");
    props = { ...props, messages: [...props.messages, ...history(65, 1, 8)] };
    render();
    await frames(16);
    const afterVeil = geometry(host);
    if (afterVeil.max - afterVeil.top > 2) failures.push(`wheel over entry veil released follow (${afterVeil.max - afterVeil.top}px gap)`);
    reports.push({ name: "wheel-during-entry", veilWheels, afterVeil });

    mount({ messages: history(0, 65) });
    await settled(host);
    const el = scroller(host);
    if (getComputedStyle(el).overflowAnchor !== "none") failures.push("native anchoring enabled");
    const first = geometry(host);
    const nativeSamples = [first];
    const wheelAtStart = trustedWheels;
    const frameDurations: number[] = [];
    let previousFrame = await frame();
    await wheel(host, -120);
    for (let i = 0; i < 20; i++) {
      const now = await frame();
      frameDurations.push(now - previousFrame);
      previousFrame = now;
      nativeSamples.push(geometry(host));
    }
    const firstMoved = first.top - geometry(host).top;
    if (Math.abs(firstMoved - 120) > 2) failures.push(`first native wheel moved ${firstMoved}px instead of 120`);
    if (nativeSamples.slice(1).some((sample, index) => sample.top > nativeSamples[index].top + 2)) failures.push("first native wheel reversed toward latest");
    if (trustedWheels === wheelAtStart) failures.push("native wheel was not delivered");
    reports.push({ name: "first-native-wheel", firstMoved, nativeSamples, frameDurations });

    const travel: unknown[] = [];
    for (let step = 0; step < 32; step++) {
      const row = visibleRow(host);
      const before = { ...geometry(host), rowTop: row.getBoundingClientRect().top };
      await wheel(host, -240);
      const positions = [before.rowTop];
      for (let i = 0; i < 12; i++) { await frame(); positions.push(row.getBoundingClientRect().top); }
      const after = { ...geometry(host), rowTop: row.getBoundingClientRect().top };
      const moved = after.rowTop - before.rowTop;
      const asked = Math.min(240, before.top);
      if (Math.abs(moved - asked) > 3) failures.push(`native travel ${step} moved reading row ${moved}px instead of ${asked}`);
      if (positions.some((top, i) => top < (positions[i - 1] ?? top) - 2 || top > before.rowTop + asked + 3)) {
        failures.push(`native travel ${step} jumped during an intermediate frame`);
      }
      travel.push({ step, moved, asked, before, after, positions });
      if (after.top <= 1 && after.rows >= 130) break;
    }
    reports.push({ name: "native-window-growth", travel });

    // Revisit an interior reading position, not the clamped start or latest.
    if (scroller(host).scrollTop < 120 || geometry(host).max - scroller(host).scrollTop < 120) {
      await wheel(host, geometry(host).max / 2 - scroller(host).scrollTop);
      await frames(12);
    }
    const retainedBefore = scroller(host).scrollTop;
    props = { ...props, paneVisible: false };
    render();
    await frames(3);
    props = { ...props, paneVisible: true };
    render();
    const revealedTop = scroller(host).scrollTop;
    const revealSamples = [revealedTop];
    for (let i = 0; i < 4; i++) { await frame(); revealSamples.push(scroller(host).scrollTop); }
    const retainedAfter = scroller(host).scrollTop;
    if (revealSamples.some((top) => Math.abs(top - retainedBefore) > 2)) failures.push(`pane reveal restored ${revealedTop}/${retainedAfter} instead of ${retainedBefore}`);
    reports.push({ name: "reading-pane-reveal", retainedBefore, revealedTop, retainedAfter, revealSamples });

    // Hold the RPC open while the reader keeps moving, then publish a real page.
    let pageCalls = 0;
    let finishPage: (() => void) | undefined;
    const recent = history(20, 10, 3);
    mount({ messages: recent, hasMoreBefore: true, onLoadOlder: () => {
      pageCalls++;
      return new Promise<void>((resolve) => { finishPage = resolve; });
    } });
    await settled(host);
    await approachHistory(host);
    await wheel(host, -120);
    await frames(14);
    if (pageCalls !== 1) failures.push(`expected one page request, got ${pageCalls}`);
    await wheel(host, -32);
    await frames(14);
    const pageRow = visibleRow(host);
    const pageBefore = pageRow.getBoundingClientRect().top;
    props = { ...props, messages: [...history(10, 10, 3), ...recent], hasMoreBefore: false };
    render();
    finishPage?.();
    const pageTops = [pageRow.getBoundingClientRect().top];
    for (let i = 0; i < 16; i++) { await frame(); pageTops.push(pageRow.getBoundingClientRect().top); }
    const pageShift = Math.max(...pageTops.map((top) => Math.abs(top - pageBefore)));
    if (pageShift > 2) failures.push(`async page shifted reading row ${pageShift}px`);
    reports.push({ name: "async-page-during-reading", pageCalls, pageBefore, pageTops, pageShift });

    flushSync(() => root!.unmount());
    root = undefined;
    for (const resolveWhileHidden of [false, true]) {
      const retainedPage = await verifyRetainedPage(i18n, recent, history(10, 10, 3), history(30, 1, 8), resolveWhileHidden);
      failures.push(...retainedPage.failures);
      trustedWheels += retainedPage.trustedWheels;
      reports.push(retainedPage);
    }

    let finishPartialPage: (() => void) | undefined;
    const wholeTurn = history(40, 1, 22);
    const partialTurn = wholeTurn.slice(1);
    mount({ messages: partialTurn, hasMoreBefore: true, onLoadOlder: () => {
      return new Promise<void>((resolve) => { finishPartialPage = resolve; });
    } });
    await settled(host);
    await approachHistory(host);
    await wheel(host, -120);
    await frames(14);
    if (!finishPartialPage) throw new Error("partial-turn page was not requested");
    const answerSelector = '[data-message-id="answer-40"]';
    const partialBefore = host.querySelector(answerSelector)!.getBoundingClientRect().top;
    props = { ...props, hasMoreBefore: false, messages: [
      ...history(39, 1), wholeTurn[0],
      { id: "early-progress-40", role: "assistant", content: "Earlier progress", createdAt },
      ...partialTurn,
    ] };
    render();
    finishPartialPage();
    const partialTops = [host.querySelector(answerSelector)!.getBoundingClientRect().top];
    for (let i = 0; i < 16; i++) {
      await frame();
      partialTops.push(host.querySelector(answerSelector)!.getBoundingClientRect().top);
    }
    const partialShift = Math.max(...partialTops.map((top) => Math.abs(top - partialBefore)));
    if (partialShift > 2) failures.push(`partial-turn prepend moved answer ${partialShift}px`);
    reports.push({ name: "partial-turn-prepend", partialBefore, partialTops, partialShift,
      geometry: geometry(host),
    });

    // Explicit return to latest must supersede an in-flight history request.
    let completeJumpPage: (() => void) | undefined;
    mount({ messages: recent, hasMoreBefore: true, onLoadOlder: () => new Promise<void>((resolve) => { completeJumpPage = resolve; }) });
    await settled(host);
    await approachHistory(host);
    await wheel(host, -120);
    await frames(14);
    const jumpButton = host.querySelector<HTMLButtonElement>(".jump-latest-btn");
    if (!jumpButton) throw new Error("jump-to-latest button missing after native scrolling");
    jumpButton.click();
    const jumpSamples = [geometry(host)];
    for (let i = 0; i < 12; i++) { await frame(); jumpSamples.push(geometry(host)); }
    if (jumpSamples.some((s) => Math.abs(s.top - s.max) > 2 || Math.abs(s.top - jumpSamples[0].top) > 2)) {
      failures.push("jump-to-latest did not land immediately and remain stable");
    }
    props = { ...props, messages: [...history(10, 10, 3), ...recent], hasMoreBefore: false };
    render();
    completeJumpPage?.();
    await frames(16);
    const jump = geometry(host);
    if (Math.abs(jump.max - jump.top) > 2) failures.push("late page took ownership after jump to latest");
    reports.push({ name: "jump-during-page", jump, jumpSamples });

    flushSync(() => root!.unmount());
    root = undefined;
    const shortEntry = await verifyShortSessionEntry(i18n, history(0, 3, 3));
    failures.push(...shortEntry.failures);
    reports.push(shortEntry);
    const disclosurePage = await verifyDisclosureDuringPage(i18n, recent, history(10, 10, 3));
    failures.push(...disclosurePage.failures);
    trustedWheels += disclosurePage.trustedWheels;
    reports.push(disclosurePage);
    const navigation = await verifyTranscriptNavigation(i18n, history(70, 4, 3), history(60, 30, 3), history(0, 8, 3));
    failures.push(...navigation.failures);
    trustedWheels += navigation.trustedWheels;
    reports.push(navigation);
    const underfilled = await verifyUnderfilledEntry(i18n, history(90, 2, 5), history(70, 20, 3));
    failures.push(...underfilled.failures);
    reports.push(underfilled);

    return { ok: failures.length === 0, failures, trustedWheels, dpr: devicePixelRatio, reports };
  } finally {
    if (root) flushSync(() => root!.unmount());
    host.removeEventListener("wheel", onWheel, true);
    host.remove();
    useAppStore.setState({ settings: initial.settings });
  }
};
globalThis.transcriptScrollProbe = probe;
