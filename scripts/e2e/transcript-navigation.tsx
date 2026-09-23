import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { createTranscriptReadingRuntime } from "../../apps/desktop/src/stores/runtime/transcript-reading-runtime";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function frames(count: number) { for (let i = 0; i < count; i++) await frame(); }

/** Navigation must position the selected projection, not a stale reading window. */
export async function verifyTranscriptNavigation(i18n: i18n, short: UiMessage[], long: UiMessage[], historical: UiMessage[]) {
  const original = useAppStore.getState();
  const failures: string[] = [];
  const reports: unknown[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;--composer-dock-height:180px";
  document.body.append(host);
  const root = createRoot(host);
  const id = "scroll-navigation-probe";
  let trustedWheels = 0;
  const onWheel = (event: WheelEvent) => { if (event.isTrusted) trustedWheels++; };
  host.addEventListener("wheel", onWheel, { passive: true, capture: true });
  const summary: SessionSummary = { id, title: id, messageCount: long.length,
    mode: "agent", permissionMode: "ask", thinkingLevel: "off",
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" };
  const runtime = createTranscriptReadingRuntime({ get: useAppStore.getState, set: useAppStore.setState }, async () => ({
    session: { ...summary, messages: historical, messageStart: 0, messageEnd: historical.length,
      hasMoreBefore: false, hasMoreAfter: true },
  }));
  let instance = 0;
  let visible = true;
  const render = () => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}><SessionPane key={instance} sessionId={id} visible={visible} /></I18nextProvider>,
  ));
  const scroller = () => host.querySelector<HTMLElement>(".thread-scroll")!;
  const sample = (latestId: string) => {
    const scroll = scroller();
    return { top: scroll.scrollTop, max: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      latestMounted: Boolean(host.querySelector(`[data-message-id="${CSS.escape(latestId)}"]`)),
      veil: Boolean(host.querySelector(".transcript-settle-veil")) };
  };
  const record = async (name: string, messages: UiMessage[]) => {
    const latestId = messages.at(-1)!.id;
    const samples = [sample(latestId)];
    for (let i = 0; i < 20; i++) { await frame(); samples.push(sample(latestId)); }
    const miss = Math.max(...samples.map((item) => Math.abs(item.max - item.top)));
    if (miss > 2) failures.push(`${name}: first-commit/frame bottom miss ${miss}px`);
    if (samples.some((item) => !item.latestMounted)) failures.push(`${name}: stale snapshot shown before selected latest message`);
    reports.push({ name, miss, samples });
  };
  try {
    useAppStore.setState({ ...runtime.actions, activeSessionId: id, messages: [],
      sessions: [summary], retainedSessionIds: [id], retainedTranscripts: {},
      sessionHistory: {}, transcriptViews: {}, runningSessions: {}, isRunning: false });
    for (const messages of [short, long]) {
      instance++;
      flushSync(() => useAppStore.setState({ messages: [], transcriptViews: {} }));
      render();
      await frames(4);
      flushSync(() => useAppStore.setState({ messages }));
      await record(`cold-entry-${messages.length}`, messages);
    }
    // A cached completed tail can be replaced by its fuller revalidated snapshot.
    instance++;
    flushSync(() => useAppStore.setState({ messages: short, transcriptViews: {} }));
    render();
    await frames(20);
    flushSync(() => useAppStore.setState({ messages: long }));
    await record("idle-revalidation", long);
    for (const running of [false, true]) {
      for (const live of [long, short]) {
        flushSync(() => useAppStore.setState({ messages: live, runningSessions: { [id]: running }, isRunning: running }));
        await frames(8);
        await runtime.actions.navigateTranscript({ sessionId: id, messageId: historical[0].id, query: "" });
        await frames(20);
        if (!useAppStore.getState().transcriptViews[id]?.focus) throw new Error("navigation fixture did not enter a historical reading window");
        const jump = host.querySelector<HTMLButtonElement>(".jump-latest-btn");
        if (!jump) throw new Error("historical reading window has no return-to-latest control");
        flushSync(() => jump.click());
        if (useAppStore.getState().transcriptViews[id]) failures.push("return-to-latest did not release historical view");
        await record(`history-to-latest-${running ? "running" : "idle"}-${live.length}`, live);
      }
    }

    flushSync(() => useAppStore.setState({ runningSessions: {}, isRunning: false,
      sessionHistory: { [id]: { messageStart: historical.length, hasMoreBefore: true } } }));
    const wheel = async (deltaY: number) => {
      const rect = scroller().getBoundingClientRect();
      await globalThis.scrollProbeDriver.wheel({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, deltaY });
    };
    await wheel(200 - scroller().scrollTop);
    await frames(10);
    await wheel(-120);
    await frames(16);
    const paged = useAppStore.getState().transcriptViews[id];
    if (!paged || paged.focus || paged.loading || paged.messages[0]?.id !== historical[0].id) {
      throw new Error("ordinary native history paging did not complete");
    }
    const pageJump = host.querySelector<HTMLButtonElement>(".jump-latest-btn");
    if (!pageJump) throw new Error("paged transcript has no return-to-latest control");
    flushSync(() => pageJump.click());
    await record("paged-to-latest", short);

    // Updating a retained pinned pane and revealing it in the same commit must
    // not paint the old deferred frame or a clamped middle offset.
    visible = false;
    render();
    await frames(3);
    flushSync(() => useAppStore.setState({ messages: long }));
    visible = true;
    render();
    await record("retained-latest-reveal", long);
    if (trustedWheels !== 2) failures.push(`navigation fixture received ${trustedWheels} native wheels instead of 2`);
    return { name: "transcript-navigation", failures, reports, trustedWheels };
  } finally {
    host.removeEventListener("wheel", onWheel, true);
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(original, true);
  }
}
