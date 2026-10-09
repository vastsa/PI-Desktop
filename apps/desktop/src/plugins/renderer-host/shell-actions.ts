import { PluginRendererError } from "../renderer-error";
import { slotRegistry, type SlotRegistry } from "../renderer-slots/registry";

export type ShellRoutes = { openPage: (page: `plugin:${string}/${string}`) => void };
let binding: ShellRoutes | undefined;
export function bindRendererShellRoutes(routes: ShellRoutes): () => void {
  binding = routes;
  return () => { if (binding === routes) binding = undefined; };
}
export function runShellAction(
  pluginId: string, payload: Record<string, unknown>, userGesture: boolean,
  routes: ShellRoutes | undefined = binding, registry: SlotRegistry = slotRegistry,
): { ok: true } {
  if (Object.keys(payload).some(key => key !== "pageId") || typeof payload.pageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.pageId)) {
    throw new PluginRendererError("PLUGIN_ACTION_INVALID_PAYLOAD", "A bounded pageId is required");
  }
  if (!userGesture) throw new PluginRendererError("PLUGIN_DRAFT_REMOTE", "Opening a page requires a user gesture");
  if (!registry.entryForKey("mainPage", `${pluginId}/${payload.pageId}`)) {
    throw new PluginRendererError("PLUGIN_ACTION_UNDECLARED", "This plugin page is not registered");
  }
  if (!routes) throw new PluginRendererError("PLUGIN_ACTION_NO_COMPOSER", "The main shell is unavailable");
  routes.openPage(`plugin:${pluginId}/${payload.pageId}`);
  return { ok: true };
}
