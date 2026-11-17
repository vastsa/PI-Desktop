import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { ComposerToolbar } from "../../apps/desktop/src/features/chat/composer/ComposerToolbar";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const i18n = createInstance();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Fixture() {
  const running = useAppStore(state => state.isRunning);
  const state = useAppStore.getState();
  const menu = useComposerModelMenu({ mode: "agent", activeSessionId: state.activeSessionId, provider: undefined, modelId: "", thinkingProvider: undefined, thinkingLevel: "off", controlsBlocked: true, configureActiveSession: state.configureActiveSession });
  return <ComposerToolbar t={i18n.t} mode="agent" planningLive={false} thinkingLevel="off" composerPermissionMode="ask" modeOpen={false} setModeOpen={() => {}} permissionOpen={false} setPermissionOpen={() => {}} controlsBlocked localToolsAllowed={false} attachmentsAllowed={false} pasting={false} pickAndAttach={async () => {}} configureActiveSession={state.configureActiveSession} showToast={state.showToast} modelMenu={menu} modelLabel="Fixture" thinkingLabel="Off" contextUsage={null} value="" modelReady sendBlocked composerTransforms={[]} activeTransformKey={null} undoTransform={null} runComposerTransform={async () => {}} undoComposerTransform={() => {}} runActive={running} hasDraftContent={false} abort={state.abort} submit={async () => {}} />;
}
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const user: UiMessage = { id: "prompt", role: "user", content: "pending", createdAt: "2026-01-01T00:00:00Z" };
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    if (channel === IPC.invoke.agentAbort) return { ok: true, data: {} as T };
    assert(channel === IPC.invoke.sessionGet, `Unexpected API ${channel}`);
    started(); await wait;
    return { ok: true, data: { session: { messages: [user, { id: "first-answer", role: "assistant", content: "finished", createdAt: "2026-01-01T00:00:00Z" }] } } as T };
  } };
  const session = (id: string) => ({ id, title: id, mode: "agent" as const, permissionMode: "ask" as const, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  useAppStore.setState({ activeSessionId: "first", sessions: [session("first"), session("second")], messages: [user], isRunning: true, runningSessions: { first: true, second: true }, pendingPermissions: {}, showToast: message => { throw new Error(message); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    const stopping = useAppStore.getState().abort(); await entered;
    const secondRows: UiMessage[] = [{ id: "second-answer", role: "assistant", content: "other live task", status: "streaming", createdAt: "2026-01-01T00:00:00Z" }];
    useAppStore.setState({ activeSessionId: "second", messages: secondRows }); await settle();
    assert(host.querySelector(".stop-btn"), "other active session still has Stop before old read finishes");
    release(); await stopping; await settle();
    assert(useAppStore.getState().runningSessions.first === false && useAppStore.getState().runningSessions.second === true, "Stop settles only its own session");
    assert(useAppStore.getState().isRunning && host.querySelector(".stop-btn"), "late Stop cannot hide current session's Stop");
    assert(useAppStore.getState().messages[0]?.id === "second-answer", "new transcript stays selected");
    return { ok: true };
  } finally { root.unmount(); host.remove(); }
} });
