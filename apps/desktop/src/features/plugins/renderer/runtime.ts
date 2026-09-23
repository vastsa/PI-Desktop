import { setRendererDiagnostic } from "./diagnostics";
import type { PiRendererApi, RendererPlugin } from "@pi-desktop/plugin-sdk";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { composerPluginRegistry, withRendererDeadline } from "./composer-registry";

type RendererInstance = { source: string; controller: AbortController; dispose: () => void };

/** One owner for loaded entries, registrations and unload callbacks. */
export function startRendererPlugins(): () => void {
  const instances = new Map<string, RendererInstance>();
  let generation = 0;
  let stopped = false;
  const report = (pluginId: string, error: unknown) => {
    setRendererDiagnostic(pluginId, error);
    console.error(`[plugin:${pluginId}] renderer`, error);
  };
  const unload = (pluginId: string) => {
    const instance = instances.get(pluginId);
    if (!instance) return;
    instances.delete(pluginId);
    instance.controller.abort();
    instance.dispose();
  };
  const refresh = async () => {
    const request = ++generation;
    try {
      const { entries } = await api.pluginRendererEntries();
      if (stopped || request !== generation) return;
      const next = new Map(entries.map((entry) => [entry.pluginId, entry.source]));
      for (const [id, instance] of instances) {
        if (next.get(id) !== instance.source) unload(id);
      }
      await Promise.all(entries.map(async ({ pluginId, source }) => {
        if (instances.has(pluginId)) return;
        setRendererDiagnostic(pluginId);
        const controller = new AbortController();
        const disposers = new Set<() => void>();
        const instance: RendererInstance = {
          source,
          controller,
          dispose: () => {
            for (const dispose of disposers) {
              try { dispose(); } catch (error) { report(pluginId, error); }
            }
            disposers.clear();
          },
        };
        instances.set(pluginId, instance);
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const rendererApi: PiRendererApi = {
          pluginId,
          signal: controller.signal,
          composer: {
            registerCompletion(id, provider) {
              controller.signal.throwIfAborted();
              try {
                const dispose = composerPluginRegistry.register(pluginId, id, provider);
                disposers.add(dispose);
                return () => { dispose(); disposers.delete(dispose); };
              } catch (error) {
                report(pluginId, error);
                return () => {};
              }
            },
            updateCompletion(id, items) {
              controller.signal.throwIfAborted();
              composerPluginRegistry.update(pluginId, id, items);
            },
            reference: {
              insert(providerId, reference) {
                controller.signal.throwIfAborted();
                composerPluginRegistry.insert({ ...reference, pluginId, providerId });
              },
            },
          },
          session: {
            list: async () => {
              controller.signal.throwIfAborted();
              const { sessions } = await api.listSessions();
              controller.signal.throwIfAborted();
              const activeId = useAppStore.getState().activeSessionId;
              return sessions.filter((session) => session.id !== activeId).map(({ id, title }) => ({ id, title: title ?? id }));
            },
            readSelected: async (sessionId) => {
              controller.signal.throwIfAborted();
              if (!composerPluginRegistry.canReadSelected(pluginId, sessionId)) throw new Error("No selected session reference");
              const { session } = await api.getSession(sessionId, { messageLimit: 400, contentLimit: 16000 });
              controller.signal.throwIfAborted();
              if (!composerPluginRegistry.canReadSelected(pluginId, sessionId)) throw new Error("Session reference resolution ended");
              if (!session) throw new Error("Referenced session is unavailable");
              return session.messages.map(({ role, content, status, parentToolCallId, composerDisplay }) => ({ role, content: composerDisplay?.content ?? content, status, parentToolCallId }));
            },
          },
        };
        try {
          const module: { default?: RendererPlugin } = await withRendererDeadline(() => import(/* @vite-ignore */ url), controller.signal, 5000);
          controller.signal.throwIfAborted();
          if (typeof module.default !== "function") throw new Error("Renderer entry must export an activation function");
          const dispose = await withRendererDeadline(async () => {
            const result = await module.default!(rendererApi);
            if (controller.signal.aborted) {
              if (typeof result === "function") result();
              return;
            }
            return result;
          }, controller.signal, 5000);
          if (typeof dispose === "function") disposers.add(dispose);
        } catch (error) {
          if (!controller.signal.aborted) report(pluginId, error);
          if (instances.get(pluginId) === instance) unload(pluginId);
        } finally {
          URL.revokeObjectURL(url);
        }
      }));
    } catch (error) {
      if (!stopped && request === generation) report("host", error);
    }
  };
  const unsubscribe = api.onPluginChanged(() => { void refresh(); });
  const unsubscribeWorkspace = useAppStore.subscribe((state, previous) => {
    if (state.workspace?.path !== previous.workspace?.path) {
      for (const id of instances.keys()) unload(id);
      void refresh();
    }
  });
  void refresh();
  return () => {
    stopped = true;
    generation += 1;
    unsubscribe();
    unsubscribeWorkspace();
    for (const pluginId of instances.keys()) unload(pluginId);
  };
}
