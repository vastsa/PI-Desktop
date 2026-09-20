import type { ComposerCompletion, ComposerCompletionProvider, ComposerPluginReference } from "@pi-desktop/plugin-sdk";

export type PluginReference = ComposerPluginReference;
export type RegisteredCompletion = {
  pluginId: string;
  providerId: string;
  provider: ComposerCompletionProvider;
};

const providers = new Map<string, RegisteredCompletion>();
const resolving = new Map<string, number>();
const listeners = new Set<() => void>();
const insertListeners = new Set<(reference: PluginReference) => void>();
let revision = 0;

function changed(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export const composerPluginRegistry = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: () => revision,
  list: () => [...providers.values()],
  register(pluginId: string, providerId: string, provider: ComposerCompletionProvider) {
    if (!providerId || !/^[^\p{L}\p{N}\s]$/u.test(provider.trigger) || typeof provider.resolve !== "function") {
      throw new Error("Invalid composer completion provider");
    }
    const key = JSON.stringify([pluginId, providerId]);
    if (providers.has(key)) throw new Error("Composer completion provider already registered");
    if (provider.trigger !== "@" && provider.trigger !== "/" && [...providers.values()].some((entry) => entry.provider.trigger === provider.trigger)) {
      throw new Error("Composer completion trigger already registered");
    }
    const entry = { pluginId, providerId, provider };
    providers.set(key, entry);
    changed();
    return () => {
      if (providers.get(key) !== entry) return;
      providers.delete(key);
      changed();
    };
  },
  update(pluginId: string, providerId: string, items: readonly ComposerCompletion[]) {
    const entry = providers.get(JSON.stringify([pluginId, providerId]));
    if (!entry) throw new Error("Composer completion provider is unavailable");
    entry.provider = { ...entry.provider, items: [...items] };
    changed();
  },
  canReadSelected(pluginId: string, refId: string) {
    return resolving.has(JSON.stringify([pluginId, refId]));
  },
  async resolve(reference: PluginReference, signal: AbortSignal) {
    const entry = this.get(reference);
    if (!entry) return { text: reference.label };
    const key = JSON.stringify([reference.pluginId, reference.refId]);
    resolving.set(key, (resolving.get(key) ?? 0) + 1);
    try {
      const result = await withRendererDeadline((childSignal) => entry.provider.resolve(reference, childSignal), signal, 5000);
      if (this.get(reference) !== entry) throw new Error("Composer completion provider was unloaded");
      return result;
    } finally {
      const count = (resolving.get(key) ?? 1) - 1;
      if (count > 0) resolving.set(key, count); else resolving.delete(key);
    }
  },
  get(reference: PluginReference) {
    return providers.get(JSON.stringify([reference.pluginId, reference.providerId]));
  },
  onInsert(listener: (reference: PluginReference) => void) {
    insertListeners.add(listener);
    return () => { insertListeners.delete(listener); };
  },
  insert(reference: PluginReference) {
    if (!this.get(reference)) throw new Error("Composer completion provider is unavailable");
    for (const listener of insertListeners) listener(reference);
  },
};

/** Bound asynchronous hooks without retaining timers after completion. */
export async function withRendererDeadline<T>(
  action: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return action(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason ?? new Error("Plugin operation cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
        timer = setTimeout(() => controller.abort(new Error("Plugin operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
