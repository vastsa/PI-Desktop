type SessionResyncEvent = {
  reason?: string;
  sessionResyncIds?: string[];
};

type SessionSelectionState = {
  page: string;
  activeSessionId?: string | null;
  selectSession: (id: string, options?: { record?: boolean }) => Promise<void>;
};

/** Refresh a recovered transcript only when it is already the visible session. */
export async function refreshActiveRemoteSession(
  event: SessionResyncEvent,
  getState: () => SessionSelectionState,
): Promise<void> {
  if (
    (event.reason !== "remote.host.reconnected" && event.reason !== "remote.session.resynced") ||
    !event.sessionResyncIds?.length
  ) return;

  const state = getState();
  const activeSessionId = state.activeSessionId;
  if (state.page !== "chat" || !activeSessionId || !event.sessionResyncIds.includes(activeSessionId)) {
    return;
  }

  await state.selectSession(activeSessionId, { record: false });
}
