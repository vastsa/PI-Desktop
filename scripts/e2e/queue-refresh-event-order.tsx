import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type QueuedTurnSummary } from "@pi-desktop/shared";
import { ComposerStatus } from "../../apps/desktop/src/features/chat/composer/ComposerStatus";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const i18n = createInstance();
const sessionId = "queue-fixture";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Fixture() {
  const queued = useAppStore(state => state.queuedPrompts[sessionId]);
  const state = useAppStore.getState();
  return <ComposerStatus t={i18n.t} queuedPrompts={queued ?? []} removeQueuedPrompt={state.removeQueuedPrompt} moveQueuedPrompt={state.moveQueuedPrompt} editQueuedPrompt={state.editQueuedPrompt} sendQueuedNow={state.sendQueuedNow} approvalPending={false} droppedDirectories={[]} openDroppedFolderAsProject={async () => {}} insertDroppedDirectoryPaths={() => {}} dismissDroppedDirectories={() => {}} />;
}

Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const queued = (id: string): QueuedTurnSummary => ({ id, sessionId, content: id, createdAt: "2026-01-01T00:00:00Z" });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    assert(channel === IPC.invoke.agentQueueList, `Unexpected API ${channel}`);
    if (++reads === 1) await waiting;
    return { ok: true, data: { entries: [queued("first"), queued("second")] } as T };
  } };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const store = useAppStore.getState();
  store.applyQueueChanged({ sessionId, entries: [queued("first"), queued("second")] });
  flushSync(() => root.render(<Fixture />));
  try {
    assert(host.querySelectorAll("[data-testid=queued-prompt]").length === 2, "initial queued prompts render");
    const reading = store.refreshQueuedPrompts(sessionId);
    store.applyQueueChanged({ sessionId, entries: [queued("second")] });
    await settle();
    assert(host.querySelectorAll("[data-testid=queued-prompt]").length === 1, "delivered prompt leaves visible queue");
    release(); await reading; await settle();
    assert(host.querySelectorAll("[data-testid=queued-prompt]").length === 1 && host.textContent?.includes("second"), "old response cannot restore delivered prompt");
    await store.refreshQueuedPrompts(sessionId); await settle();
    assert(host.querySelectorAll("[data-testid=queued-prompt]").length === 2, "later authoritative refresh still works");
    return { ok: true, reads };
  } finally { root.unmount(); host.remove(); }
} });
