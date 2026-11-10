import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { PermissionCard } from "../../apps/desktop/src/components/PermissionCard";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { headAsk } from "../../apps/desktop/src/lib/pending-asks";
import { headPermission } from "../../apps/desktop/src/lib/pending-permissions";

const i18n = createInstance();
const sessionId = "interactive-fixture";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Fixture() {
  const ask = useAppStore(state => headAsk(state.pendingAsks, sessionId));
  const permission = useAppStore(state => headPermission(state.pendingPermissions, sessionId));
  return <I18nextProvider i18n={i18n}>{ask ? <AskToolCard request={ask} /> : null}{permission ? <PermissionCard permission={permission} /> : null}</I18nextProvider>;
}

Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const errors: string[] = [];
  const calls = new Map<string, number>();
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    assert(channel === IPC.invoke.askToolResolve || channel === IPC.invoke.toolResolvePermission, `Unexpected API ${channel}`);
    const count = (calls.get(channel) ?? 0) + 1;
    calls.set(channel, count);
    return count === 1 ? { ok: false, error: { code: "NETWORK_ERROR", message: "fixture disconnected" } } : { ok: true, data: {} as T };
  } };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  useAppStore.setState({ sessions: [{ id: sessionId, title: "Fixture", mode: "agent", permissionMode: "ask", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], showToast: message => { errors.push(message); } });
  flushSync(() => root.render(<Fixture />));
  const click = (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); assert(button && !button.disabled, `Enabled button ${selector}`); flushSync(() => button.click()); };
  try {
    useAppStore.setState({ pendingAsks: { [sessionId]: [{ requestId: "ask", sessionId, toolCallId: "call", questions: [{ question: "Choose", options: ["alpha", "beta"] }] }] } });
    await settle();
    click(".asktool-options [role=radio]");
    click(".asktool-card-header-actions .btn-primary"); await settle();
    assert(host.querySelector(".asktool-card"), "failed ask remains mounted");
    assert(host.querySelector(".asktool-option.selected")?.textContent?.includes("alpha"), "selected answer survives");
    assert(errors[0] === "fixture disconnected", "ask displays transport error");
    click(".asktool-card-header-actions .btn-primary"); await settle();
    assert(!host.querySelector(".asktool-card"), "successful retry removes only answered ask");
    useAppStore.setState({ pendingPermissions: { [sessionId]: [{ requestId: "permission", sessionId, toolCallId: "permission-call", toolName: "Bash", argsPreview: { command: "echo fixture" }, risk: "low" }] } });
    await settle();
    click(".permission-card-actions .btn-primary"); await settle();
    assert(host.querySelector(".permission-card"), "failed permission remains mounted");
    assert(errors[1] === "fixture disconnected", "permission displays transport error");
    click(".permission-card-actions .btn-primary"); await settle();
    assert(!host.querySelector(".permission-card"), "successful retry removes permission");
    return { ok: true, askAttempts: calls.get(IPC.invoke.askToolResolve), permissionAttempts: calls.get(IPC.invoke.toolResolvePermission) };
  } finally { root.unmount(); host.remove(); }
} });
