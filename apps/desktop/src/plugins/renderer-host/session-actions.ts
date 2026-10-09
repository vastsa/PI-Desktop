import { PluginRendererError } from "../renderer-error";

export type RendererSessionContext = { sessionId: string; managedByPlugin?: string } | null;
export type SessionRoutes = {
  readContext(): RendererSessionContext;
  openView(pluginId: string, viewId: string, sessionId: string): void;
};
let current: SessionRoutes | undefined;

/** The app shell owns this binding; individual plugin loads never replace it. */
export function bindRendererSessionRoutes(routes: SessionRoutes): () => void {
  current = routes;
  return () => { if (current === routes) current = undefined; };
}

export const rendererSessionRoutes: SessionRoutes = {
  readContext: () => current?.readContext() ?? null,
  openView: (pluginId, viewId, sessionId) => {
    if (!current) throw new PluginRendererError("PLUGIN_ACTION_NO_COMPOSER", "No active session");
    current.openView(pluginId, viewId, sessionId);
  },
};

export function runSessionAction(
  pluginId: string,
  action: "session.readContext" | "workPanel.openView",
  payload: Record<string, unknown>,
  routes: SessionRoutes,
  userGesture: boolean,
): unknown {
  if (action === "session.readContext") {
    if (Object.keys(payload).length) {
      throw new PluginRendererError("PLUGIN_ACTION_INVALID_PAYLOAD", "session.readContext takes an empty object");
    }
    return routes.readContext();
  }
  const { viewId, expectedSessionId } = payload;
  if (Object.keys(payload).some(key => key !== "viewId" && key !== "expectedSessionId") ||
      typeof viewId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(viewId) ||
      typeof expectedSessionId !== "string" || !expectedSessionId || expectedSessionId.length > 128) {
    throw new PluginRendererError("PLUGIN_ACTION_INVALID_PAYLOAD", "workPanel.openView requires viewId and expectedSessionId");
  }
  if (!userGesture) throw new PluginRendererError("PLUGIN_DRAFT_REMOTE", "Opening a view requires a user gesture");
  if (routes.readContext()?.sessionId !== expectedSessionId) {
    throw new PluginRendererError("PLUGIN_DRAFT_STALE", "The active session changed");
  }
  routes.openView(pluginId, viewId, expectedSessionId);
  return { ok: true };
}
