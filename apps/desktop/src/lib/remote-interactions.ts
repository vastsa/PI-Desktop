import { api } from "./api";
import { removeAsk } from "./pending-asks";
import { removePermission } from "./pending-permissions";
import { useAppStore } from "../stores/app-store";

/** One app-shell subscription; remote snapshots never touch local queues. */
export function subscribeRemoteInteractions(): () => void {
  return api.onRemoteInteractions((event) => {
    if (!event?.sessionId?.startsWith("remote:")) return;
    useAppStore.setState((state) => {
      const id = event.sessionId;
      if (event.kind === "resolved") {
        return event.requestKind === "permission"
          ? { pendingPermissions: removePermission(state.pendingPermissions, id, event.requestId) }
          : { pendingAsks: removeAsk(state.pendingAsks, id, event.requestId) };
      }
      const pendingPermissions = { ...state.pendingPermissions };
      const pendingAsks = { ...state.pendingAsks };
      delete pendingPermissions[id];
      delete pendingAsks[id];
      const permissions = event.permissions.filter((item) => item.sessionId === id);
      const asks = event.asks.filter((item) => item.sessionId === id);
      if (permissions.length) pendingPermissions[id] = permissions;
      if (asks.length) pendingAsks[id] = asks;
      return { pendingPermissions, pendingAsks };
    });
  });
}
