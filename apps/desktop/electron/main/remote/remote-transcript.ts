/**
 * Reshape a remote host's RACP session resources into the exact
 * {@link SessionSummary}/{@link SessionDetail} the renderer already consumes for
 * a local session. The renderer never learns the transport: only the
 * `source: "remote"` badge, the display-only `remote` location, the surfaces
 * `capabilities` turn off, and the namespaced id distinguish it (spec §3.4).
 *
 * RACP does not carry a per-session `thinkingLevel` (it is a desktop provider
 * concern), so remote summaries default it to `"off"`; the renderer treats it
 * as advisory display state and never round-trips it back to the host.
 */
import type {
  RacpSession,
  RacpSessionSnapshot,
  SessionCapabilities,
  SessionDetail,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";

/** The paired host a remote session belongs to, as the host list names it. */
export type RemoteHostIdentity = { hostKey: string; hostLabel: string };

/**
 * What the renderer may offer for a remote session. Prompting, stopping, and
 * refreshing run on the host. Attachments, `@` mentions, model selection,
 * steering, and history editing have no RACP operation in this release, so
 * the renderer hides them instead of offering a call that would fail.
 */
export const REMOTE_SESSION_CAPABILITIES: Readonly<SessionCapabilities> = {
  canPrompt: true,
  canStop: true,
  canRefresh: true,
  canAttach: false,
  canMentionFiles: false,
  canSelectModel: false,
  canSteer: false,
  canEditHistory: false,
};

/**
 * `messageCount` for a session whose count the desktop has not observed.
 * `session/list` carries no count, and `0` would claim the session is empty:
 * the renderer would reuse it as a New Task slot and paint an empty frame
 * before its transcript loads. The count is only ever used as that empty
 * predicate, so "not known to be empty" is the honest value.
 */
export const REMOTE_UNKNOWN_MESSAGE_COUNT = 1;

/** Build the flat summary a session list / header row renders. */
export function remoteSessionSummary(
  remoteSessionId: string,
  session: RacpSession,
  host: RemoteHostIdentity,
  messageCount: number = REMOTE_UNKNOWN_MESSAGE_COUNT,
): SessionSummary {
  return {
    id: remoteSessionId,
    source: "remote",
    capabilities: { ...REMOTE_SESSION_CAPABILITIES },
    remote: {
      hostKey: host.hostKey,
      hostLabel: host.hostLabel,
      ...(session.workspaceLabel ? { workspaceLabel: session.workspaceLabel } : {}),
    },
    title: session.title,
    messageCount,
    // RACP's mode and permission-mode literals are a subset of the renderer's,
    // so they pass through unchanged; `inherit` is desktop-only and never sent.
    mode: session.mode,
    thinkingLevel: "off",
    permissionMode: session.permissionMode,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
  };
}

/**
 * Build the full transcript from an attach snapshot. `snapshot.items` already
 * carries the canonical {@link UiMessage} in each item's `content` (the host's
 * `toRacpItem` projection), so the transcript is a direct map with no lossy
 * reconstruction.
 */
export function snapshotToSessionDetail(
  remoteSessionId: string,
  snapshot: RacpSessionSnapshot,
  host: RemoteHostIdentity,
): SessionDetail {
  const messages = snapshot.items.map((item) => item.content as UiMessage);
  return {
    ...remoteSessionSummary(remoteSessionId, snapshot.session, host, messages.length),
    messages,
    hasMoreBefore: snapshot.hasMoreHistory,
    hasMoreAfter: false,
  };
}
