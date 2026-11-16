import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { createSessionRuntime } from "../../apps/desktop/src/stores/runtime/session-runtime";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";

const i18n = createInstance();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Fixture() { const messages = useAppStore(state => state.messages); return <I18nextProvider i18n={i18n}>{messages.map(message => <MessageRow key={message.id} message={message} isRunning={false} />)}</I18nextProvider>; }
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const sessionId = "cache-fixture";
  const original: UiMessage[] = [{ id: "prompt", role: "user", content: "original fixture", createdAt: "2026-01-01T00:00:00Z" }];
  const edited: UiMessage[] = [{ ...original[0]!, content: "edited fixture" }];
  useAppStore.setState({ activeSessionId: "other", runningSessions: {}, retainedTranscripts: {}, messages: [] });
  const runtime = createSessionRuntime({ get: useAppStore.getState, set: useAppStore.setState });
  runtime.cacheSessionTranscript(sessionId, original);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    assert(channel === IPC.invoke.sessionGet, `Unexpected API ${channel}`);
    await gate; return { ok: true, data: { session: { id: sessionId, messages: original, messageStart: 8, hasMoreBefore: true } } as T };
  } };
  const reading = runtime.loadSessionDetail(sessionId, { messageLimit: 100, contentLimit: 65536 });
  runtime.cacheSessionTranscript(sessionId, edited, { messageStart: 0, hasMoreBefore: false });
  finish(); await reading;
  const recovered = runtime.sessionTranscriptCache.get(sessionId)!;
  useAppStore.setState({ activeSessionId: sessionId, messages: recovered, sessions: [{ id: sessionId, title: "Fixture", mode: "agent", permissionMode: "ask", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    assert(host.textContent?.includes("edited fixture") && !host.textContent?.includes("original fixture"), "returning to the session renders its newer edit");
    assert(runtime.sessionHistoryCache.get(sessionId)?.messageStart === 0, "new cache window remains paired with the new messages");
    return { ok: true, rendered: "edited fixture" };
  } finally { root.unmount(); host.remove(); }
} });
