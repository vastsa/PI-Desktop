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
  const menu = useComposerModelMenu({ mode: "agent", activeSessionId: "native-pi:fixture", provider: undefined, modelId: "", thinkingProvider: undefined, thinkingLevel: "off", controlsBlocked: true, configureActiveSession: state.configureActiveSession });
  return <ComposerToolbar t={i18n.t} mode="agent" planningLive={false} thinkingLevel="off" composerPermissionMode="ask" modeOpen={false} setModeOpen={() => {}} permissionOpen={false} setPermissionOpen={() => {}} controlsBlocked localToolsAllowed={false} attachmentsAllowed={false} pasting={false} pickAndAttach={async () => {}} configureActiveSession={state.configureActiveSession} showToast={state.showToast} modelMenu={menu} modelLabel="Fixture" thinkingLabel="Off" contextUsage={null} value="" modelReady sendBlocked composerTransforms={[]} activeTransformKey={null} undoTransform={null} runComposerTransform={async () => {}} undoComposerTransform={() => {}} runActive={running} hasDraftContent={false} abort={state.abort} submit={async () => {}} />;
}
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const errors: string[] = [];
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    if (channel === IPC.invoke.agentAbort) return { ok: true, data: { ok: true } as T };
    assert(channel === IPC.invoke.sessionGet, `Unexpected API ${channel}`);
    return { ok: false, error: { code: "NETWORK_ERROR", message: "fixture detail disconnected" } };
  } };
  const rows: UiMessage[] = [{ id: "answer", role: "assistant", content: "known native answer", status: "streaming", createdAt: "2026-01-01T00:00:00Z" }];
  useAppStore.setState({ activeSessionId: "native-pi:fixture", sessions: [{ id: "native-pi:fixture", title: "Fixture", source: "pi-native", mode: "agent", permissionMode: "ask", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], messages: rows, isRunning: true, runningSessions: { "native-pi:fixture": true }, showToast: message => { errors.push(message); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    const stop = host.querySelector<HTMLButtonElement>(".stop-btn"); assert(stop, "native Stop mounts"); flushSync(() => stop.click()); await settle();
    assert(errors[0] === "fixture detail disconnected", "refresh failure remains visible");
    assert(!useAppStore.getState().isRunning && !useAppStore.getState().runningSessions["native-pi:fixture"], "confirmed Stop is preserved");
    assert(useAppStore.getState().messages[0]?.content === "known native answer", "refresh failure does not clear transcript");
    assert(!host.querySelector(".stop-btn") && host.querySelector(".send-btn"), "toolbar no longer claims the source is running");
    return { ok: true };
  } finally { root.unmount(); host.remove(); }
} });
