import { useCallback, useLayoutEffect, useRef } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { createPluginShellLayoutController } from "./plugin-shell-layout-controller";
import {
  applyPluginShellLayoutCommand,
  readPluginShellLayout,
  type PluginPanelGeometry,
  type PluginShellLayoutOwner,
  type PluginShellRendererState,
} from "./plugin-shell-layout-model";

type Options = Omit<PluginShellRendererState, "contextId" | "panelGeometry" | "sidebarResizing" | "sidebarPreferredWidth"> & {
  getSidebarPreferredWidth: () => number;
  commitSidebarWidth: PluginShellLayoutOwner["commitSidebarWidth"];
  toggleSidebar: () => void;
  autoCollapseSidebar: () => void;
  t: (key: string) => string;
};
type Controller = ReturnType<typeof createPluginShellLayoutController>;

/** Adapts real React commits and child geometry to the transport controller. */
export function usePluginShellLayout(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<Controller | null>(null);
  const geometry = useRef<PluginPanelGeometry | null>(null);
  const sidebarResizing = useRef(false);
  const contextVersion = useRef(0);
  // Subscribe so tab selection/labels and selection-in-progress also commit a
  // snapshot even when the outer app-shell hook does not consume those fields.
  useAppStore((state) => state.workPanelTabs);
  useAppStore((state) => state.activeWorkPanelTabId);
  useAppStore((state) => state.pluginViews);
  useAppStore((state) => state.selectingSessionId);
  useAppStore((state) => state.sessions);

  useLayoutEffect(() => {
    const bootId = crypto.randomUUID();
    let contextKey = "";
    const getShell = (): PluginShellRendererState => {
      const value = latest.current;
      const store = useAppStore.getState();
      const key = JSON.stringify([store.activeSessionId, store.selectingSessionId, store.workspace?.path, store.sessions.find((session) => session.id === store.activeSessionId)?.projectPath, value.page]);
      if (key !== contextKey) { contextKey = key; contextVersion.current += 1; }
      return {
        ...value,
        contextId: `${bootId}:${contextVersion.current}`,
        sidebarPreferredWidth: value.getSidebarPreferredWidth(),
        sidebarResizing: sidebarResizing.current,
        panelGeometry: geometry.current,
      };
    };
    const owner: PluginShellLayoutOwner = {
      getShell,
      getStore: useAppStore.getState,
      t: (key) => latest.current.t(key),
      commitSidebarWidth: (width, maximum) => latest.current.commitSidebarWidth(width, maximum),
      toggleSidebar: () => latest.current.toggleSidebar(),
      autoCollapseSidebar: () => latest.current.autoCollapseSidebar(),
    };
    const instance = createPluginShellLayoutController({
      bootId,
      read: () => readPluginShellLayout(owner),
      apply: (command, contextId) => applyPluginShellLayoutCommand(owner, command, contextId),
      publish: api.publishPluginShellLayout,
      respond: api.answerPluginShellLayout,
      reportError: (error) => console.error("Plugin shell layout bridge failed", error),
    });
    controller.current = instance;
    let offRequests: (() => void) | undefined;
    try { offRequests = api.onPluginShellLayoutRequest(instance.receive); }
    catch (error) { console.error("Plugin shell layout bridge is unavailable", error); }
    // Count every selection, including A→B→A within one batched render, so a
    // queued command cannot mistake a returned session for its original context.
    const offStore = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId || state.selectingSessionId !== previous.selectingSessionId || state.workspace?.path !== previous.workspace?.path) {
        contextVersion.current += 1;
      }
    });
    instance.committed();
    return () => {
      offRequests?.();
      offStore();
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, []);
  useLayoutEffect(() => { controller.current?.committed(); });

  const onWorkPanelLayoutChange = useCallback((value: PluginPanelGeometry | null) => {
    geometry.current = value;
    controller.current?.notify();
  }, []);
  const onSidebarResizingChange = useCallback((resizing: boolean) => {
    sidebarResizing.current = resizing;
    controller.current?.notify();
  }, []);
  return { onWorkPanelLayoutChange, onSidebarResizingChange };
}
