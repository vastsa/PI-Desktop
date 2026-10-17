import type { SessionCapabilities } from "@pi-desktop/shared";
import { sessionAllows } from "../lib/remote-session-safety";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { useAppStore } from "../stores/app-store";

/** Retained transcripts authorize against their own session, never the visible workspace. */
export function useChatSessionCapability(capability: keyof SessionCapabilities): boolean {
  const paneSessionId = useSlotSessionId();
  return useAppStore((state) => {
    const id = paneSessionId || state.activeSessionId;
    return sessionAllows(
      state.sessions.find((session) => session.id === id) ??
        (id?.startsWith("remote:") ? { id } : undefined),
      capability,
    );
  });
}

/** OS file-manager actions apply only to files owned by this computer. */
export function useChatNativeFilesAllowed(): boolean {
  const paneSessionId = useSlotSessionId();
  return useAppStore((state) => {
    const id = paneSessionId || state.activeSessionId;
    const session = state.sessions.find((item) => item.id === id);
    return sessionAllows(session ?? (id?.startsWith("remote:") ? { id } : undefined), "canUseLocalTools")
      && !session?.remoteWorkspace && (id ? true : !state.workspace?.remote);
  });
}
