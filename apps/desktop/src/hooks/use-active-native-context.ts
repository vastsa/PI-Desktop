import { useSyncExternalStore } from "react";
import type { NativeContextSnapshot } from "@pi-desktop/shared";
import {
  selectNativeContextSnapshot,
  subscribeNativeContext,
} from "../lib/native-context-store";
import { useAppStore } from "../stores/app-store";

/**
 * The context snapshot reported for the conversation the user is looking at.
 *
 * Selection is strict on purpose: the snapshot only ever describes the session,
 * provider and model it was reported for. Switching to another model — a
 * different provider, or another deployment with a similar model id —
 * returns nothing, and the composer keeps showing what it showed before.
 */
export function useActiveNativeContext(): NativeContextSnapshot | undefined {
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId),
  );
  return useSyncExternalStore(
    subscribeNativeContext,
    () =>
      selectNativeContextSnapshot({
        sessionId,
        providerId: session?.providerId,
        modelId: session?.modelId,
      }),
    () => undefined,
  );
}
