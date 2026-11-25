import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type PluginViewMeta } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const i18n = createInstance();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const view = (pluginId: string): PluginViewMeta => ({ pluginId, viewId: "view", ref: `${pluginId}/view`, title: `${pluginId} view`, pluginName: pluginId, order: 0 });
  const releases: Array<(views: PluginViewMeta[]) => void> = [];
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string) => {
    assert(channel === IPC.invoke.pluginViews, `Unexpected API ${channel}`);
    return { ok: true, data: await new Promise<PluginViewMeta[]>(resolve => releases.push(resolve)) as T };
  } };
  useAppStore.setState({ activeSessionId: "fixture", activeProjectPath: "/first", pluginViews: [], workPanelOpen: true, workPanelTabs: [{ id: "new", kind: "new" }], activeWorkPanelTabId: "new", ready: false });
  const first = useAppStore.getState().refreshPluginViews();
  useAppStore.setState({ activeProjectPath: "/second" });
  const second = useAppStore.getState().refreshPluginViews();
  releases[1]!([view("second")]); await second;
  const host = document.createElement("div"); host.style.cssText = "height:700px;width:600px"; document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><WorkPanel /></I18nextProvider>)); await settle();
    assert(host.querySelector('[data-work-panel-launcher-item="second/view"]'), "current project's view is in production launcher");
    releases[0]!([view("first")]); await first; await settle();
    assert(host.querySelector('[data-work-panel-launcher-item="second/view"]') && !host.querySelector('[data-work-panel-launcher-item="first/view"]'), "older project's views cannot replace current launcher");
    return { ok: true };
  } finally { root.unmount(); host.remove(); }
} });
