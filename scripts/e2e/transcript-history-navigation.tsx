import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Real history navigation: ${label}`);
    await frame();
  }
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Real history navigation: ${label}`);
}

declare global { var transcriptHistoryNavigationProbe: () => Promise<unknown>; }
globalThis.transcriptHistoryNavigationProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const originalState = useAppStore.getState();
  const originalBridge = window.piDesktop;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ds-bg-primary)";
  document.body.append(host);
  const root = createRoot(host);
  const createdAt = "2026-11-04T00:00:00Z";
  let id = "";
  let data: UiMessage[] = [];
  let summary: SessionSummary;
  let pending: { resolve: (value: unknown) => void; response: unknown }[] = [];
  const reads: number[] = [];
  const unexpected: string[] = [];
  window.piDesktop = { channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let value: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0];
        assert(input && typeof input === "object" && "id" in input && input.id === id, "unexpected session request");
        const before = "messageBefore" in input && typeof input.messageBefore === "number" ? input.messageBefore : undefined;
        const end = before === undefined ? data.length : Math.min(data.length, before);
        const limit = before === undefined ? 35 : "messageLimit" in input ? Number(input.messageLimit) : 100;
        const start = Math.max(0, end - limit);
        const response = { session: { ...summary, messages: data.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < data.length } };
        if (before !== undefined && before < data.length) {
          reads.push(before);
          value = await new Promise(resolve => pending.push({ resolve, response }));
        } else value = response;
      } else if (channel === IPC.invoke.sessionList) value = { sessions: [summary] };
      else if (channel === IPC.invoke.plansPending) value = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) value = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) value = { entries: [] };
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) value = { ok: true };
      else { unexpected.push(channel); return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: channel } }; }
      return { ok: true, data: value as T };
    },
  };
  const scroller = () => host.querySelector<HTMLDivElement>(".thread-scroll")!;
  const busy = () => host.querySelector('.transcript-history-loading[aria-hidden="false"]') !== null;
  const bottom = () => Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) <= 2;
  const render = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <div className="session-panes"><SessionPane key={id} sessionId={id} visible /></div>
  </I18nextProvider>));
  const reset = async (name: string, role: "user" | "mixed" = "user") => {
    flushSync(() => root.render(null));
    for (const item of pending.splice(0)) item.resolve(item.response);
    id = `navigation-${name}`;
    data = Array.from({ length: 280 }, (_, index) => ({ id: `${id}-${index}`,
      role: role === "user" || index % 30 === 0 ? "user" : "assistant",
      content: `Message ${index}\n\n${"Stationary visible reading paragraph. ".repeat(80)}`,
      createdAt, status: "complete" }));
    summary = { id, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
      providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt, messageCount: data.length };
    useAppStore.setState({ sessions: [summary], messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {}, sessionCompactions: {},
      providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {}, pendingPermissions: {}, planningStates: {},
      runningSessions: {}, isRunning: false, workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      settings: { ...originalState.settings, smoothStreaming: false } });
    await useAppStore.getState().selectSession(id);
    render();
    await until(() => Boolean(scroller()) && !host.querySelector('[data-transcript-settling="true"]') && bottom(), "cold pane follows latest");
    await frame();
  };
  const begin = () => {
    const el = scroller();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
    el.scrollTo({ top: 80, behavior: "instant" });
    const viewport = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => {
      const r = node.getBoundingClientRect(); return r.height > 0 && r.bottom > viewport.top + 20 && r.top < viewport.bottom;
    });
    assert(row?.dataset.messageId, "visible message missing before loading");
    const messageId = row.dataset.messageId;
    const measure = () => {
      const node = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      return node?.isConnected ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : Infinity;
    };
    const offset = measure();
    const samples: number[] = [];
    let handle = 0;
    const sample = () => { samples.push(measure()); handle = requestAnimationFrame(sample); };
    handle = requestAnimationFrame(sample);
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { messageId, offset, measure, samples, stop: () => cancelAnimationFrame(handle) };
  };
  const finish = async () => {
    assert(pending.length === 1, `expected one held physical page, got ${pending.length}`);
    const item = pending.shift()!;
    item.resolve(item.response);
    await until(() => !busy() && !useAppStore.getState().transcriptViews[id]?.loading, "page did not settle");
    for (let n = 0; n < 8; n++) await frame();
  };
  const results: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const role of ["user", "mixed"] as const) {
      await reset(`quiet-${role}`, role);
      const anchor = begin();
      await until(() => pending.length === 1, "ordinary paging did not reach Host boundary");
      for (let n = 0; n < 6; n++) await frame();
      const during = anchor.measure();
      await finish();
      anchor.stop();
      const result = { role, duringDrift: Math.abs(during - anchor.offset),
        finalDrift: Math.abs(anchor.measure() - anchor.offset), maxDrift: Math.max(...anchor.samples.map(x => Math.abs(x - anchor.offset))),
        historical: Boolean(useAppStore.getState().transcriptViews[id]), top: scroller().scrollTop };
      console.log("REAL_HISTORY_QUIET " + JSON.stringify(result));
      if (result.maxDrift > 2) failures.push(`loading moved visible ${role} message: ${JSON.stringify(result)}`);
      results.push(result);
    }
    for (const scenario of [
      { timing: "pending", role: "user" }, { timing: "settled", role: "user" },
      { timing: "pending", role: "mixed" }, { timing: "settled", role: "mixed" },
    ] as const) {
      const { timing, role } = scenario;
      await reset(`latest-${timing}-${role}`, role);
      const anchor = begin();
      try {
        await until(() => pending.length === 1, "pending page for latest navigation");
        if (timing === "settled") await finish();
        const button = host.querySelector<HTMLButtonElement>(".jump-latest-btn");
        assert(button, "actual return-to-latest button missing");
        const readsBeforeJump = reads.length;
        button.click();
        if (timing === "pending") { const item = pending.shift()!; item.resolve(item.response); }
        await until(() => !useAppStore.getState().transcriptViews[id] && bottom(), `latest button failed after ${timing} page`);
        for (let n = 0; n < 15; n++) { await frame(); assert(bottom(), "latest navigation was reversed after reaching bottom"); }
        assert(pending.length === 0 && reads.length === readsBeforeJump, "latest navigation started another history page");
        const result = { timing, role, top: scroller().scrollTop, height: scroller().scrollHeight,
          historical: Boolean(useAppStore.getState().transcriptViews[id]), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches };
        console.log("REAL_HISTORY_LATEST " + JSON.stringify(result));
        results.push(result);
      } catch (error) {
        const result = { timing, role, error: String(error), top: scroller().scrollTop, height: scroller().scrollHeight,
          historical: Boolean(useAppStore.getState().transcriptViews[id]), pending: pending.length };
        console.log("REAL_HISTORY_LATEST " + JSON.stringify(result));
        failures.push(JSON.stringify(result));
      } finally { anchor.stop(); }
    }
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected.join(",")}`);
    assert(failures.length === 0, failures.join("\n"));
    return { ok: true, cases: results, reads };
  } finally {
    for (const item of pending.splice(0)) item.resolve(item.response);
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(originalState);
    window.piDesktop = originalBridge;
  }
};
