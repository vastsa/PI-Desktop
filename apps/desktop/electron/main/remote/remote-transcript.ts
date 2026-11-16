/**
 * Reshape a remote host's RACP session resources into the exact
 * {@link SessionSummary}/{@link SessionDetail} the renderer already consumes for
 * a local session. The renderer never learns the transport: only the
 * `source: "remote"` badge and the namespaced id distinguish it (spec §3.4).
 *
 * A Host publishes its own provider/model/thinking binding for each session, so
 * the Composer can offer the Host's model catalog and switch it through
 * `session/configure`. Hosts that predate the catalog simply omit those fields,
 * which leaves the Composer on its read-only display.
 */
import type {
  RacpSession,
  RacpSessionSnapshot,
  SessionDetail,
  SessionSummary,
  SessionThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import { SESSION_THINKING_LEVELS } from "@pi-desktop/shared";
import { parseRemoteSessionId } from "./backend-router.js";

function sessionThinkingLevel(value: string | undefined): SessionThinkingLevel | undefined {
  return SESSION_THINKING_LEVELS.find((level) => level === value);
}

/** Build the flat summary a session list / header row renders. */
export function racpSessionToSummary(
  remoteSessionId: string,
  session: RacpSession,
  messageCount: number,
  hostLabel?: string,
): SessionSummary {
  const thinkingLevel = sessionThinkingLevel(session.thinkingLevel);
  return {
    id: remoteSessionId,
    source: "remote",
    remoteHostKey: parseRemoteSessionId(remoteSessionId)?.hostKey,
    remoteHostLabel: hostLabel ?? parseRemoteSessionId(remoteSessionId)?.hostKey,
    remoteProjectId: session.projectId,
    remoteWorkspaceLabel: session.workspaceLabel,
    capabilities: {
      canPrompt: true, canStop: true, canRefresh: true,
      // The Host owns the binding and exposes `session/configure` for it. A
      // Host that publishes no model catalog leaves the Composer on a
      // read-only display, which the renderer decides from the catalog itself.
      canConfigureModel: true,
      canAttach: false, canSteer: false,
      canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
      canReadWorkspace: true,
    },
    title: session.title,
    messageCount,
    // RACP's mode and permission-mode literals are a subset of the renderer's,
    // so they pass through unchanged; `inherit` is desktop-only and never sent.
    mode: session.mode,
    ...(session.providerId ? { providerId: session.providerId } : {}),
    ...(session.modelId ? { modelId: session.modelId } : {}),
    // A Host that predates the field (or has no reasoning to configure)
    // reports no level; the renderer's neutral value keeps the control off.
    thinkingLevel: thinkingLevel ?? "off",
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
