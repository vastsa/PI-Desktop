import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { createSessionRuntime } from "../../apps/desktop/src/stores/runtime/session-runtime";
import { createProjectSlice } from "../../apps/desktop/src/stores/slices/project-slice";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { Button } from "../../apps/desktop/src/components/ui";

const i18n = createInstance();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const id = "deleted-fixture";
  useAppStore.setState({ activeSessionId: "other", sessions: [{ id, title: "Delete fixture", mode: "agent", permissionMode: "ask", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], refreshSessions: async () => {} });
  const access = { get: useAppStore.getState, set: useAppStore.setState };
  const runtime = createSessionRuntime(access);
  const actions = createProjectSlice({ ...access, runtime, withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)), persistCurrentSidebar() {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    if (channel === IPC.invoke.sessionGet) { await gate; return { ok: true, data: { session: { id, messages: [{ id: "old", role: "user", content: "deleted history" }] } } as T }; }
    assert(channel === IPC.invoke.sessionDelete || channel === IPC.invoke.pluginViewClose, `Unexpected API ${channel}`);
    return { ok: true, data: {} as T };
  } };
  const full = runtime.loadFullSessionMessages(id);
  const bounded = runtime.loadSessionDetail(id, { messageLimit: 100 });
  let deletion: Promise<void> | undefined;
  function Fixture() {
    const sessions = useAppStore(state => state.sessions);
    return <>{sessions.map(session => <div key={session.id} data-session={session.id}>{session.title}<Button onClick={() => { deletion = actions.deleteSession(session.id); }}>Delete</Button></div>)}</>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    const button = host.querySelector<HTMLButtonElement>("button"); assert(button, "session deletion entry renders"); flushSync(() => button.click()); await deletion; await settle();
    assert(!host.querySelector(`[data-session="${id}"]`), "deleted session leaves the view");
    release(); const [fullResult, boundedResult] = await Promise.all([full, bounded]); await settle();
    assert(fullResult === null && boundedResult.session === null, "late reads cannot hand deleted history back to actions");
    assert(!runtime.sessionTranscriptCache.has(id) && !runtime.sessionHistoryCache.has(id), "deleted cache stays released");
    assert(!host.querySelector(`[data-session="${id}"]`), "late results cannot restore the deleted session");
    return { ok: true };
  } finally { root.unmount(); host.remove(); }
} });
