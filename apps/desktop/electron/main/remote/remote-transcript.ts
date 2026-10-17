/**
 * Reshape a remote host's RACP session resources into the exact
 * {@link SessionSummary}/{@link SessionDetail} the renderer already consumes for
 * a local session. The renderer never learns the transport: only the
 * `source: "remote"` badge and the namespaced id distinguish it (spec §3.4).
 *
 * RACP does not carry a per-session `thinkingLevel` (it is a desktop provider
 * concern), so remote summaries default it to `"off"`; the renderer treats it
 * as advisory display state and never round-trips it back to the host.
 */
import type {
  RacpSession,
  RacpSessionSnapshot,
  SessionDetail,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { parseRemoteSessionId } from "./backend-router.js";

/** Build the flat summary a session list / header row renders. */
export function racpSessionToSummary(
  remoteSessionId: string,
  session: RacpSession,
  messageCount: number,
  hostLabel?: string,
): SessionSummary {
  return {
    id: remoteSessionId,
    source: "remote",
    remoteHostKey: parseRemoteSessionId(remoteSessionId)?.hostKey,
    remoteHostLabel: hostLabel ?? parseRemoteSessionId(remoteSessionId)?.hostKey,
    remoteProjectId: session.projectId,
    remoteWorkspaceLabel: session.workspaceLabel,
    capabilities: {
      canPrompt: true, canStop: true, canRefresh: true,
      canConfigureModel: false, canAttach: false, canSteer: false,
      canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
      canReadWorkspace: true,
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
  hostLabel?: string,
): SessionDetail {
  const items = new Map(snapshot.items.map((item) => [item.id, item]));
  for (const item of snapshot.activeItems ?? []) items.set(item.id, item);
  const messages = [...items.values()].map((item) => item.content as UiMessage);
  return {
    ...racpSessionToSummary(remoteSessionId, snapshot.session, messages.length, hostLabel),
    messages,
    hasMoreBefore: snapshot.hasMoreHistory,
    hasMoreAfter: false,
  };
}
