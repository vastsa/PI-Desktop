/**
 * The sidebar's remote section (D627): one group per paired host with its
 * connection state, a new-session button, and the host's sessions. Rows are
 * rendered by the sidebar so they keep the same selection, status, and menu
 * behavior as local rows. The section only appears once a host is paired.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSummary, SessionSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { NewRemoteSessionDialog } from "../../features/remote/NewRemoteSessionDialog";
import { TooltipButton } from "../ui";
import { IconNewSession, IconServer } from "../icons";

export type RemoteHostSessionsProps = {
  /** Every remote session the store lists, across hosts. */
  sessions: SessionSummary[];
  renderSessionRows: (sessions: SessionSummary[]) => ReactNode;
  onCreated: (session: SessionSummary) => void;
  onError: (error: unknown) => void;
};

/** Group remote sessions by host, keeping each host's incoming order. */
export function groupRemoteSessionsByHost(
  sessions: SessionSummary[],
): Map<string, SessionSummary[]> {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const hostKey = session.remote?.hostKey;
    if (!hostKey) continue;
    const group = groups.get(hostKey);
    if (group) group.push(session);
    else groups.set(hostKey, [session]);
  }
  return groups;
}

export function RemoteHostSessions({
  sessions,
  renderSessionRows,
  onCreated,
  onError,
}: RemoteHostSessionsProps) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [creatingFor, setCreatingFor] = useState<RemoteHostSummary | null>(null);

  // A host that opens, closes, or is paired announces itself as a session
  // list change, so that event is the refresh cue for connection state.
  useEffect(() => {
    let current = true;
    const load = () => {
      api
        .listRemoteHosts()
        .then((result) => {
          if (current) setHosts(result.hosts);
        })
        .catch(() => {
          // The pairing surface reports host errors; an empty section is the
          // honest fallback here.
          if (current) setHosts([]);
        });
    };
    load();
    const unsubscribe = api.onSessionsChanged(load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  const groups = useMemo(() => groupRemoteSessionsByHost(sessions), [sessions]);
  const closeDialog = useCallback(() => setCreatingFor(null), []);

  if (hosts.length === 0) return null;
  return (
    <section
      className="sidebar-standalone-sessions sidebar-remote-sessions"
      aria-labelledby="sidebar-remote-sessions-label"
      data-sidebar-session-section="remote"
    >
      <div className="sidebar-list-toolbar sidebar-list-toolbar-secondary">
        <span id="sidebar-remote-sessions-label" className="sidebar-list-label">
          {t("remote.sidebarSection")}
        </span>
      </div>
      {hosts.map((host) => {
        const hostSessions = groups.get(host.hostKey) ?? [];
        const headingId = `sidebar-remote-host-${host.hostKey}`;
        return (
          <div
            key={host.hostKey}
            className="sidebar-remote-host"
            role="group"
            aria-labelledby={headingId}
            data-remote-host={host.hostKey}
            data-connected={host.connected ? "true" : "false"}
          >
            <div className="sidebar-remote-host-header">
              <IconServer size={13} aria-hidden />
              <span id={headingId} className="sidebar-remote-host-label" title={host.label}>
                {host.label}
              </span>
              <span className="sidebar-remote-host-state">
                {host.connected ? t("remote.connected") : t("remote.disconnected")}
              </span>
              <TooltipButton
                type="button"
                className="sidebar-toolbar-button"
                data-action="new-remote-session"
                tooltip={t("remote.newSession")}
                ariaLabel={t("remote.newSession")}
                disabled={!host.connected}
                onClick={() => setCreatingFor(host)}
              >
                <IconNewSession size={14} />
              </TooltipButton>
            </div>
            <div className="sidebar-session-group-body">
              {hostSessions.length > 0 ? (
                renderSessionRows(hostSessions)
              ) : (
                <div className="sidebar-session-empty">{t("remote.noSessions")}</div>
              )}
            </div>
          </div>
        );
      })}
      {creatingFor ? (
        <NewRemoteSessionDialog
          hostKey={creatingFor.hostKey}
          hostLabel={creatingFor.label}
          onClose={closeDialog}
          onCreated={onCreated}
          onError={onError}
        />
      ) : null}
    </section>
  );
}
