/**
 * Start a session on a paired remote host (D625). The user picks one of the
 * host's registered projects, or browses the host's directories (bounded by
 * its browse root) and registers one. The session runs on the host's default
 * model, so there is no model choice here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RemoteProjectBrowseResult,
  RemoteProjectSummary,
  SessionSummary,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { Button, TooltipButton } from "../../components/ui";
import { IconChevronLeft, IconClose, IconFolder } from "../../components/icons";

export type NewRemoteSessionDialogProps = {
  hostKey: string;
  hostLabel: string;
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
  onError: (error: unknown) => void;
};

export function NewRemoteSessionDialog({
  hostKey,
  hostLabel,
  onClose,
  onCreated,
  onError,
}: NewRemoteSessionDialogProps) {
  const { t } = useTranslation();
  useBlockingOverlay();
  const [projects, setProjects] = useState<RemoteProjectSummary[] | null>(null);
  const [browse, setBrowse] = useState<RemoteProjectBrowseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    api
      .listRemoteProjects(hostKey)
      .then((result) => {
        if (!closedRef.current) setProjects(result.projects.filter((project) => !project.archived));
      })
      .catch((error) => {
        if (closedRef.current) return;
        setProjects([]);
        onError(error);
      });
    return () => {
      closedRef.current = true;
    };
  }, [hostKey, onError]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** Run one host call at a time; a second click while one is in flight is dropped. */
  const run = useCallback(
    async (work: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await work();
      } catch (error) {
        if (!closedRef.current) onError(error);
      } finally {
        busyRef.current = false;
        if (!closedRef.current) setBusy(false);
      }
    },
    [onError],
  );

  const create = (projectId: string) =>
    run(async () => {
      const { session } = await api.createRemoteSession({ hostKey, projectId });
      if (closedRef.current) return;
      onCreated(session);
      onClose();
    });

  const openDirectory = (path?: string) =>
    run(async () => {
      const result = await api.browseRemoteProject(hostKey, path);
      if (!closedRef.current) setBrowse(result);
    });

  const registerAndCreate = (path: string) =>
    run(async () => {
      const { project } = await api.registerRemoteProject(hostKey, path);
      if (closedRef.current) return;
      const { session } = await api.createRemoteSession({ hostKey, projectId: project.id });
      if (closedRef.current) return;
      onCreated(session);
      onClose();
    });

  const dialogId = "new-remote-session-dialog";
  const dialog = (
    <div
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        className="dialog session-rename-dialog remote-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        aria-busy={busy || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div className="session-rename-dialog-heading">
            <h2 id={`${dialogId}-title`} className="session-rename-dialog-title">
              {t("remote.newSessionTitle", { host: hostLabel })}
            </h2>
            <p id={`${dialogId}-description`} className="session-rename-dialog-description">
              {t("remote.newSessionDescription")}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={t("remote.cancel")}
            ariaLabel={t("remote.cancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        {browse ? (
          <div className="remote-session-dialog-body">
            <div className="remote-session-dialog-path">
              <TooltipButton
                type="button"
                className="icon-btn icon-btn-square"
                tooltip={t("remote.browseUp")}
                ariaLabel={t("remote.browseUp")}
                disabled={busy}
                onClick={() => (browse.parent ? void openDirectory(browse.parent) : setBrowse(null))}
              >
                <IconChevronLeft size={14} />
              </TooltipButton>
              <span title={browse.path}>{browse.path}</span>
            </div>
            <ul className="remote-session-dialog-list" aria-label={t("remote.browseDirectories")}>
              {browse.entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" disabled={busy} onClick={() => void openDirectory(entry.path)}>
                    <IconFolder size={14} aria-hidden />
                    {entry.name}
                  </button>
                </li>
              ))}
              {browse.entries.length === 0 ? (
                <li className="remote-session-dialog-empty">{t("remote.browseEmpty")}</li>
              ) : null}
            </ul>
            <div className="session-rename-dialog-actions">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setBrowse(null)}>
                {t("remote.back")}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                onClick={() => void registerAndCreate(browse.path)}
              >
                {t("remote.useThisFolder")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="remote-session-dialog-body">
            {projects === null ? (
              <div className="remote-session-dialog-empty">{t("remote.loadingProjects")}</div>
            ) : (
              <ul className="remote-session-dialog-list" aria-label={t("remote.projects")}>
                {projects.map((project) => (
                  <li key={project.id}>
                    <button type="button" disabled={busy} onClick={() => void create(project.id)}>
                      <IconFolder size={14} aria-hidden />
                      {project.label}
                    </button>
                  </li>
                ))}
                {projects.length === 0 ? (
                  <li className="remote-session-dialog-empty">{t("remote.noProjects")}</li>
                ) : null}
              </ul>
            )}
            <div className="session-rename-dialog-actions">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {t("remote.cancel")}
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={() => void openDirectory()}>
                {t("remote.browseFolder")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
