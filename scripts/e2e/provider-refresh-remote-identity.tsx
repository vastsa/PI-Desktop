import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type SessionSummary } from "@pi-desktop/shared";
import { ComposerToolbar } from "../../apps/desktop/src/features/chat/composer/ComposerToolbar";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { sessionAllows } from "../../apps/desktop/src/lib/remote-session-safety";
import { Button } from "../../apps/desktop/src/components/ui";

const i18n = createInstance();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
let refresh: Promise<void> | undefined;
function Fixture() {
  const sessions = useAppStore(state => state.sessions);
  const state = useAppStore.getState();
  const target = sessions.find(session => session.id === state.activeSessionId);
  const menu = useComposerModelMenu({ mode: "agent", activeSessionId: state.activeSessionId, provider: undefined, modelId: "", thinkingProvider: undefined, thinkingLevel: "off", controlsBlocked: true, configureActiveSession: state.configureActiveSession });
  return <><Button onClick={() => { refresh = state.refreshProviders(); }}>Refresh providers</Button><ComposerToolbar t={i18n.t} mode="agent" planningLive={false} thinkingLevel="off" composerPermissionMode="ask" modeOpen={false} setModeOpen={() => {}} permissionOpen={false} setPermissionOpen={() => {}} controlsBlocked localToolsAllowed={sessionAllows(target, "canUseLocalTools")} attachmentsAllowed={false} stopAllowed={sessionAllows(target, "canStop")} pasting={false} pickAndAttach={async () => {}} configureActiveSession={state.configureActiveSession} showToast={state.showToast} modelMenu={menu} modelLabel="Remote fixture" thinkingLabel="Off" contextUsage={null} value="" modelReady sendBlocked composerTransforms={[]} activeTransformKey={null} undoTransform={null} runComposerTransform={async () => {}} undoComposerTransform={() => {}} runActive={state.isRunning} hasDraftContent={false} abort={state.abort} submit={async () => {}} /></>;
}
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    if (channel === IPC.invoke.providersList) return { ok: true, data: { providers: [] } as T };
    if (channel === IPC.invoke.sessionList) return { ok: true, data: { sessions: [] } as T };
    if (channel === IPC.invoke.settingsGet) return { ok: true, data: {} as T };
    assert(channel === IPC.invoke.appGetOnboarding, `Unexpected API ${channel}`);
    return { ok: true, data: {} as T };
  } };
  const remote: SessionSummary = { id: "remote:fixture", source: "remote", title: "Remote", mode: "agent", permissionMode: "ask", remoteProjectId: "remote-project", capabilities: { canPrompt: true, canStop: false, canRefresh: true, canUseLocalTools: false, canReadWorkspace: false, canConfigureModel: false, canEditMessages: false }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  useAppStore.setState({ activeSessionId: remote.id, sessions: [remote], isRunning: true, ready: false, providerModels: {}, settings: undefined });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    assert(host.querySelector<HTMLButtonElement>(".stop-btn")?.disabled, "remote capability denies Stop initially");
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Refresh providers"); assert(button, "refresh entry mounts"); flushSync(() => button.click()); await refresh; await settle();
    assert(useAppStore.getState().sessions[0]?.source === "remote", "refresh retains active remote identity");
    assert(host.querySelector<HTMLButtonElement>(".stop-btn")?.disabled, "temporarily missing host cannot enable denied Stop");
    return { ok: true };
  } finally { root.unmount(); host.remove(); }
} });
