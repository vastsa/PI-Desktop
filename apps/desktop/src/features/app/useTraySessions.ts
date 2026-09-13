import { useEffect } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

/** Keep local organization mirrored while Main reads durable session/inbox state. */
export function useTraySessions({ setSearchOpen, reopenSidebar }: {
  setSearchOpen: (open: boolean) => void;
  reopenSidebar: () => void;
}) {
  useEffect(() => {
    let disposed = false;
    let scheduled = false;

    const activate = (sessionId: string | null) => {
      const store = useAppStore.getState();
      setSearchOpen(false);
      if (sessionId === null) {
        store.setPage("chat");
        reopenSidebar();
        return;
      }
      void store.selectSession(sessionId).catch((error) => {
        if (!disposed) {
          store.showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        }
      });
    };

    const sync = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (disposed) return;
        const store = useAppStore.getState();
        if (!store.ready) return;
        void api.setTraySessionPreferences({
          sessionMeta: store.sessionMeta,
          archivedProjectPaths: Object.entries(store.projectMeta)
            .filter(([, meta]) => meta.archived)
            .map(([path]) => path),
          // The sidebar presents its legacy manual setting using recent order.
          sort: store.sessionView.sort === "manual" ? "recent" : store.sessionView.sort,
        }).catch((error) => console.error("Tray session synchronization failed", error));
      });
    };

    // Main waits for the shell's post-bootstrap menuRendererReady acknowledgement.
    const offActivation = api.onTraySessionActivated(activate);
    const offStore = useAppStore.subscribe((state, previous) => {
      if (
        state.ready !== previous.ready ||
        state.sessionMeta !== previous.sessionMeta ||
        state.projectMeta !== previous.projectMeta ||
        state.sessionView !== previous.sessionView
      ) sync();
    });
    sync();
    return () => {
      disposed = true;
      offActivation();
      offStore();
    };
  }, [reopenSidebar, setSearchOpen]);
}
