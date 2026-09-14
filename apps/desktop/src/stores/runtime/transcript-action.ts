import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";

/** Load canonical action input only when an explicit action targets old history. */
export async function prepareTranscriptAction(
  { get, set }: StoreAccess,
  runtime: Pick<SessionRuntime, "loadFullSessionMessages" | "cacheSessionTranscript">,
  messageId: string,
) {
  const state = get();
  const id = state.activeSessionId;
  if (!id || state.isRunning) return null;
  const history = state.sessionHistory[id];
  if (!history?.hasMoreBefore && !history?.contentLimited &&
    state.messages.some((message) => message.id === messageId)) return state;
  let messages;
  try {
    // Cache ownership is checked after this asynchronous read, too: a new
    // turn may have already appended a live tail while the read was pending.
    messages = await runtime.loadFullSessionMessages(id, false);
  } catch (error) {
    if (get().activeSessionId === id)
      get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    return null;
  }
  const current = get();
  if (!messages || current.activeSessionId !== id || current.isRunning || current.selectingSessionId ||
    current.messages !== state.messages) return null;
  if (!messages.some((message) => message.id === messageId)) return null;
  runtime.cacheSessionTranscript(id, messages, { messageStart: 0, hasMoreBefore: false });
  set({ messages, sessionHistory: {
    ...current.sessionHistory, [id]: { messageStart: 0, hasMoreBefore: false },
  } });
  return get();
}
