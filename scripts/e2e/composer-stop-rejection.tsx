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
  const menu = useComposerModelMenu({ mode: "agent", activeSessionId: "stop-fixture", provider: undefined, modelId: "", thinkingProvider: undefined, thinkingLevel: "off", controlsBlocked: true, configureActiveSession: state.configureActiveSession });
  return <ComposerToolbar t={i18n.t} mode="agent" planningLive={false} thinkingLevel="off" composerPermissionMode="ask" modeOpen={false} setModeOpen={() => {}} permissionOpen={false} setPermissionOpen={() => {}} controlsBlocked localToolsAllowed={false} attachmentsAllowed={false} pasting={false} pickAndAttach={async () => {}} configureActiveSession={state.configureActiveSession} showToast={state.showToast} modelMenu={menu} modelLabel="Fixture" thinkingLabel="Off" contextUsage={null} value="" modelReady sendBlocked composerTransforms={[]} activeTransformKey={null} undoTransform={null} runComposerTransform={async () => {}} undoComposerTransform={() => {}} runActive={running} hasDraftContent={false} abort={state.abort} submit={async () => {}} />;
}
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  let attempts = 0;
  const errors: string[] = [];
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    assert(channel === IPC.invoke.agentAbort, `Unexpected API ${channel}`);
    if (++attempts === 1) return { ok: false, error: { code: "NETWORK_ERROR", message: "fixture disconnected" } };
    return { ok: true, data: { ok: true } as T };
  } };
  const rows: UiMessage[] = [{ id: "prompt", role: "user", content: "work", createdAt: "2026-01-01T00:00:00Z" }, { id: "answer", role: "assistant", content: "partial answer", status: "streaming", createdAt: "2026-01-01T00:00:00Z" }];
  useAppStore.setState({ activeSessionId: "stop-fixture", sessions: [{ id: "stop-fixture", title: "Fixture", source: "desktop", mode: "agent", permissionMode: "ask", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], messages: rows, isRunning: true, runningSessions: { "stop-fixture": true }, pendingPermissions: {}, showToast: message => { errors.push(message); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    const clickStop = () => { const button = host.querySelector<HTMLButtonElement>(".stop-btn"); assert(button && !button.disabled, "Stop remains enabled"); flushSync(() => button.click()); };
    clickStop(); await settle();
    assert(errors[0] === "fixture disconnected", "failed Stop displays the transport error");
    assert(useAppStore.getState().isRunning && useAppStore.getState().messages[1]?.status === "streaming", "failed Stop retains the running state and streaming answer");
    clickStop(); await settle();
    assert(!useAppStore.getState().isRunning && useAppStore.getState().messages[1]?.status === "aborted", "successful retry settles streaming answer");
    assert(!host.querySelector(".stop-btn") && host.querySelector(".send-btn"), "toolbar returns to Send after confirmed Stop");
    return { ok: true, attempts, errors };
  } finally { root.unmount(); host.remove(); }
} });
