/**
 * Mounts once per app window and keeps its plugin renderer modules in step
 * with the plugin list and the open project (`rendererLoadSpecs`): a plugin
 * loads when it becomes eligible, reloads when the main process hands out a
 * new generation, and unloads — taking its registrations and style sheets
 * along — when it stops being eligible or the host goes away. It also hides
 * the plugins' layers while the host waits on the user's own decision.
 */
import { useEffect, useLayoutEffect } from "react";
import { sessionAwaitsDecision, useHostSafetySurfaceMounted } from "../../lib/host-safety-layer";
import { useAppStore } from "../../stores/app-store";
import { pluginLayers } from "../renderer-layers/layer-stack";
import { installRendererImportMap } from "./import-map";
import { bindRendererSessionRoutes } from "./session-actions";
import { PluginRendererError } from "../renderer-error";
import { pluginWorkPanelTab } from "../../lib/work-panel-tabs";
import { rendererLoadSpecs, rendererModules } from "./loader";
import { bindRendererShellRoutes } from "./shell-actions";
import { slotRegistry } from "../renderer-slots/registry";
import "../renderer-slots/slot-shell.css";

export function PluginRendererHost(): null {
  const plugins = useAppStore((state) => state.plugins);
  const projectPath = useAppStore((state) => state.workspace?.path ?? null);
  const awaitsDecision = useAppStore(sessionAwaitsDecision);
  const safetySurfaceMounted = useHostSafetySurfaceMounted();
  const suspended = awaitsDecision || safetySurfaceMounted;

  useEffect(() => {
    // Plugin modules import bare `react`: the map must exist before the first.
    installRendererImportMap();
    rendererModules.sync(rendererLoadSpecs(plugins, projectPath));
  }, [plugins, projectPath]);

  useLayoutEffect(() => bindRendererSessionRoutes({
    readContext: () => {
      const state = useAppStore.getState();
      if (!state.activeSessionId || state.page !== "chat") return null;
      const session = state.sessions.find(item => item.id === state.activeSessionId);
      return { sessionId: state.activeSessionId, ...(session?.managedByPlugin
        ? { managedByPlugin: session.managedByPlugin } : {}) };
    },
    openView: (pluginId, viewId, sessionId) => {
      const state = useAppStore.getState();
      if (state.activeSessionId !== sessionId || state.page !== "chat") {
        throw new PluginRendererError("PLUGIN_DRAFT_STALE", "The active session changed");
      }
      if (!state.pluginViews.some(view => view.pluginId === pluginId && view.viewId === viewId)) {
        throw new PluginRendererError("PLUGIN_ACTION_UNDECLARED", "The plugin view is not available");
      }
      state.openWorkPanelTabForSession(sessionId, pluginWorkPanelTab(pluginId, viewId));
    },
  }), []);

  useLayoutEffect(() => bindRendererShellRoutes({
    openPage: page => useAppStore.getState().setPage(page),
  }), []);

  useEffect(() => {
    const reconcile = () => {
      const state = useAppStore.getState();
      if (state.page.startsWith("plugin:") && !slotRegistry.entryForKey("mainPage", state.page.slice(7))) {
        state.setPage("chat", { record: false });
      }
    };
    const unSlots = slotRegistry.subscribe(reconcile);
    const unState = useAppStore.subscribe(reconcile);
    return () => { unSlots(); unState(); };
  }, []);

  useEffect(() => () => rendererModules.sync([]), []);

  // Before paint, so a decision never shows with a layer over it.
  useLayoutEffect(() => {
    pluginLayers.setSuspended(suspended);
  }, [suspended]);

  return null;
}
