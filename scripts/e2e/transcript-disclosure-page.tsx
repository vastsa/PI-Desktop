import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function frames(count: number) { for (let i = 0; i < count; i++) await frame(); }

/** A disclosure may borrow reading ownership, but it cannot cancel the store read. */
export async function verifyDisclosureDuringPage(i18n: i18n, recent: UiMessage[], older: UiMessage[]) {
  const failures: string[] = [];
  const reports: unknown[] = [];
  let trustedWheels = 0;
  const recordWheel = (event: WheelEvent) => { if (event.isTrusted) trustedWheels++; };
  for (const keepScrolling of [false, true]) {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;--composer-dock-height:180px";
    document.body.append(host);
    host.addEventListener("wheel", recordWheel, { passive: true, capture: true });
    const root = createRoot(host);
    let messages = recent;
    let hasMoreBefore = true;
    let finishPage: (() => void) | undefined;
    let pageCalls = 0;
    const loadOlder = () => {
      pageCalls++;
      if (finishPage) return Promise.resolve();
      return new Promise<void>((resolve) => { finishPage = resolve; });
    };
    const render = () => flushSync(() => root.render(
      <I18nextProvider i18n={i18n}><TranscriptDisclosureProvider>
        <ChatTranscript sessionId={`disclosure-page-${keepScrolling}`} messages={messages}
          hasMoreBefore={hasMoreBefore} onLoadOlder={loadOlder} isRunning={false} />
      </TranscriptDisclosureProvider></I18nextProvider>,
    ));
    try {
      render();
      await frames(16);
      const scroller = host.querySelector<HTMLElement>(".thread-scroll")!;
      const wheel = async (deltaY: number) => {
        const rect = scroller.getBoundingClientRect();
        await globalThis.scrollProbeDriver.wheel({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, deltaY });
      };
      await wheel(200 - scroller.scrollTop);
      await frames(12);
      await wheel(-120);
      await frames(14);
      if (!finishPage) throw new Error("disclosure-page read did not start");
      const viewport = scroller.getBoundingClientRect();
      const title = [...host.querySelectorAll<HTMLButtonElement>(".turn-process > .tool-activity-header")].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top > viewport.top && rect.bottom < viewport.bottom;
      });
      if (!title) throw new Error("no visible process title for pending page");
      flushSync(() => title.click());
      await frames(16);
      if (title.getAttribute("aria-expanded") !== "true") throw new Error("pending page process did not expand");
      if (keepScrolling) { await wheel(-24); await frames(12); }
      const target = keepScrolling
        ? [...host.querySelectorAll<HTMLElement>("[data-message-id]")].find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
          })
        : title;
      if (!target) throw new Error("pending page reading anchor missing");
      const before = target.getBoundingClientRect().top;
      messages = [...older, ...recent];
      hasMoreBefore = false;
      render();
      finishPage();
      const tops = [target.getBoundingClientRect().top];
      for (let i = 0; i < 16; i++) { await frame(); tops.push(target.getBoundingClientRect().top); }
      const shift = Math.max(...tops.map((top) => Math.abs(top - before)));
      if (pageCalls !== 1) failures.push(`disclosure restarted ${pageCalls} pending page reads`);
      reports.push({ keepScrolling, pageCalls, before, tops, shift });
      if (!target.isConnected || shift > 2) failures.push(`page after disclosure (continued scroll=${keepScrolling}) shifted ${shift}px`);
    } finally {
      flushSync(() => root.unmount());
      host.removeEventListener("wheel", recordWheel, true);
      host.remove();
    }
  }
  return { name: "disclosure-during-page", failures, reports, trustedWheels };
}
