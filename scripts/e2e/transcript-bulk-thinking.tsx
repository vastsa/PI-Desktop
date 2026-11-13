import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/locales/en";
import type { UiMessage, AppSettings } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

const message = (id: string, role: UiMessage["role"], extra: Partial<UiMessage> = {}): UiMessage => ({
  id, role, content: role === "user" ? "Explain" : "", createdAt: "2026-11-13T00:00:00Z", ...extra,
});
const turn = (prefix: string) => [
  message(`${prefix}-user`, "user"),
  message(`${prefix}-a`, "assistant", { thinking: `${prefix} first reasoning` }),
  message(`${prefix}-tool`, "tool", { toolName: "Read", toolStatus: "success", toolCallId: `${prefix}-call`, toolArgs: { path: "example.txt" }, content: "file contents" }),
  message(`${prefix}-b`, "assistant", { thinking: `${prefix} second reasoning` }),
  message(`${prefix}-answer`, "assistant", { content: "Final answer" }),
];
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error(`Timed out: ${label}`); await frame(); }
}

declare global { var transcriptDisclosureProbe: () => Promise<unknown>; }
globalThis.transcriptDisclosureProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const host = document.createElement("div");
  host.style.cssText = "height:600px;width:700px;display:flex;flex-direction:column";
  document.body.append(host);
  const style = document.createElement("style");
  style.textContent = ".thread-wrap{display:flex;flex-direction:column;min-height:0;flex:1}.thread-scroll{overflow:auto;min-height:0;flex:1}.thinking-prose{min-height:160px}.transcript-settle-veil{display:none}.thread-content{padding-bottom:700px}.message-row.user{min-height:300px}";
  document.head.append(style);
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const originalGet = api.getSession;
  const old = turn("old"), latest = turn("latest");
  let failRead = false;
  let reads = 0;
  let readGate: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  api.getSession = async (id, options) => {
    reads++;
    if (readGate) await readGate;
    if (failRead) throw new Error("history read failed");
    return { session: { id, title: id, messages: options?.messageBefore === 100 ? old : latest, hasMoreBefore: options?.messageBefore !== 100, messageStart: options?.messageBefore === 100 ? 0 : 100 } as never };
  };
  const settings = { showThinking: true, autoCollapseThinking: true, autoCollapseSettledGroups: true, transcriptDisplayMode: "fully-folded" } as AppSettings;
  useAppStore.setState({ settings });
  let currentId = "bulk-a";
  let shown = latest;
  let running = false;
  const render = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <TranscriptDisclosureProvider key={currentId} sessionId={currentId}>
      <ChatTranscript sessionId={currentId} messages={shown} hasMoreBefore={shown === latest} isRunning={running} />
    </TranscriptDisclosureProvider>
  </I18nextProvider>));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);
  const openRows = () => host.querySelectorAll(".thinking.open").length;
  const click = async (text: string) => { const b = button(text); check(b, `missing ${text}`); b.click(); await until(() => !b.disabled, text); await frame(); };
  try {
    render();
    check(openRows() === 0, "settled defaults should remain folded");
    await click("Expand all thinking");
    await until(() => openRows() === 2, "two reasoning rows and ancestors expanded");
    check(host.querySelectorAll(".tool-row:not(.thinking).open").length === 0, "tool payload must stay closed");
    const leaf = host.querySelector<HTMLButtonElement>(".thinking .tool-row-header")!;
    leaf.click();
    await until(() => openRows() === 1, "manual close after bulk expansion");
    await click("Expand all thinking");
    check(openRows() === 2, "repeat expansion must override manual close");
    shown = [...old, ...latest]; render();
    await until(() => openRows() === 4, "unmounted history follows the batch when loaded");
    await click("Collapse all thinking");
    check(openRows() === 0, "collapse all leaves");
    check(host.querySelectorAll('.turn-process > .tool-activity-header[aria-expanded="true"]').length > 0, "collapse leaves must retain parent expansion");
    const scroller = host.querySelector<HTMLElement>(".thread-scroll")!;
    const answer = host.querySelector<HTMLElement>('[data-message-id="latest-answer"]')!;
    scroller.scrollTop += answer.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
    scroller.dispatchEvent(new Event("scroll"));
    await frame(); await frame();
    const answerOffset = answer.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    check(answerOffset >= 0 && answerOffset < scroller.clientHeight, "answer must be visible before bulk expansion");
    await click("Expand all thinking");
    await until(() => Math.abs(answer.getBoundingClientRect().top - scroller.getBoundingClientRect().top - answerOffset) < 2,
      "bulk expansion preserves the visible answer position");
    const newTurn = turn("new"); shown = [...shown, ...newTurn]; render();
    check(openRows() === 4, "future turns follow original settings");
    currentId = "bulk-b"; render();
    check(openRows() === 0, "other sessions must not inherit expansion");
    currentId = "bulk-a"; render();
    await until(() => openRows() === 4, "pane remount preserves per-session choices");
    for (const mode of ["flat", "command-first", "fully-folded"] as const) {
      flushSync(() => useAppStore.setState({ settings: { ...settings, transcriptDisplayMode: mode } }));
      check(openRows() === 4, `expansion survives ${mode}`);
    }
    flushSync(() => useAppStore.setState({ settings: { ...settings, showThinking: false } }));
    check(!button("Expand all thinking") && openRows() === 0, "Show thinking off remains authoritative");
    flushSync(() => useAppStore.setState({ settings }));
    const streaming = message("stream", "assistant", { thinking: "Live reasoning", status: "streaming" });
    shown = [...shown, message("stream-user", "user"), streaming]; running = true; render();
    await click("Expand all thinking");
    check(openRows() === 7, "all existing reasoning including streaming expands");
    shown = shown.map((item) => item.id === "stream" ? { ...item, status: "complete" as const } : item);
    running = false; render();
    check(openRows() === 7, "completion must not undo explicit expansion");
    failRead = true;
    await click("Collapse all thinking");
    check(openRows() === 7, "read failure must not partially collapse visible history");
    check(useAppStore.getState().toasts.some((toast) => toast.message.includes("history read failed")), "read failure must be visible");
    failRead = false;
    readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    button("Collapse all thinking")!.click();
    await until(() => Boolean(button("Collapse all thinking")?.disabled), "pending operation disables controls");
    currentId = "bulk-c"; render();
    releaseRead!(); await frame(); await frame();
    currentId = "bulk-a"; render();
    check(openRows() === 7, "a departed control must not apply a late result");
    check(errors.length === 0, `render errors: ${errors}`);
    return { ok: true, reads, checks: "actual controls, paginated reads, nested groups, reading anchor, manual overrides, new turns, streaming completion, session isolation, remount, three modes, hidden thinking, read errors and late responses" };
  } finally { api.getSession = originalGet; flushSync(() => root.unmount()); host.remove(); style.remove(); }
};
