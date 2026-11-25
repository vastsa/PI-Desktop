import type { PluginModelContextInput } from "@pi-desktop/plugin-sdk";

type ContextProvider = {
  pluginId: string;
  eligible: () => boolean;
  read: (input: PluginModelContextInput, signal: AbortSignal) => Promise<string | undefined>;
};

type FrozenTurn = {
  turnId: string;
  controller: AbortController;
  context: Promise<{ provider: ContextProvider; text: string; revoked?: boolean }[]>;
};

/** Main owns the snapshot and answers each provider attempt from that snapshot.
 * Never refill it: a plugin enabled mid-turn starts on the next turn only. */
export function createPluginModelContext(deps: {
  isDispatchable: (sessionId: string, turnId: string) => boolean;
  projectFor: (sessionId: string) => string | null | undefined;
  inProject: (pluginId: string, projectPath: string | null) => boolean;
  providers: (inScope: (pluginId: string) => boolean) => ContextProvider[];
  projectId: (projectPath: string) => Promise<string | undefined>;
}) {
  const turns = new Map<string, FrozenTurn>();
  const end = (sessionId: string, turnId: string) => {
    const turn = turns.get(sessionId);
    if (turn?.turnId !== turnId) return;
    turns.delete(sessionId);
    turn.controller.abort();
  };

  const read = async (params: Record<string, unknown>) => {
    const { sessionId, turnId, modelKey } = params;
    if (typeof sessionId !== "string" || typeof turnId !== "string" ||
        !deps.isDispatchable(sessionId, turnId)) return [];
    const projectPath = deps.projectFor(sessionId);
    if (projectPath === undefined) return [];
    let frozen = turns.get(sessionId);
    if (frozen?.turnId !== turnId) {
      if (frozen) end(sessionId, frozen.turnId);
      const controller = new AbortController();
      const { signal } = controller;
      const inScope = (pluginId: string) => !signal.aborted &&
        deps.isDispatchable(sessionId, turnId) && deps.projectFor(sessionId) === projectPath &&
        deps.inProject(pluginId, projectPath);
      const providers = deps.providers(inScope);
      const context = (async () => {
        const projectId = providers.length && projectPath ? await deps.projectId(projectPath) : undefined;
        const input: PluginModelContextInput = {
          sessionId, turnId,
          ...(projectId ? { projectId } : {}),
          ...(typeof modelKey === "string" && modelKey.length <= 512 ? { modelKey } : {}),
        };
        const results = await Promise.all(providers.map(async (provider) => {
          const text = await provider.read(input, signal);
          return text && provider.eligible() ? { provider, text } : undefined;
        }));
        return results.filter((entry) => entry !== undefined);
      })();
      frozen = { turnId, controller, context };
      turns.set(sessionId, frozen);
    }
    const results = await frozen.context;
    // A permission or scope loss observed in this turn is irreversible here.
    return results.flatMap((entry) => {
      if (entry.revoked || !entry.provider.eligible()) {
        entry.revoked = true;
        return [];
      }
      return [{ pluginId: entry.provider.pluginId, text: entry.text }];
    });
  };

  return { read, end };
}
