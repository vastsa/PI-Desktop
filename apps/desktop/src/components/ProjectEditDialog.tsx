import { useEffect, useEffectEvent, useRef, useState } from "react";
import { portalToBody } from "../lib/portal-visibility";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, ProjectGroupRoot } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { MAX_PROJECT_NAME_CHARS } from "../lib/sidebar-preferences";
import { Button, TooltipButton } from "./ui";
import {
  IconClose,
  IconFolder,
  IconMonitor,
  IconNewProject,
  IconStar,
  IconX,
} from "./icons";

export type ProjectEditTarget = {
  name: string;
  path: string;
  groupId?: string;
  roots?: ProjectGroupRoot[];
  legacy?: boolean;
};

function pathParts(path: string) {
  return path.split(/[\\/]/).filter(Boolean);
}

function folderName(path: string) {
  return pathParts(path).at(-1) ?? path;
}

function folderParent(path: string) {
  const parts = pathParts(path);
  return parts.length > 1 ? `…/${parts.slice(-2, -1)[0]}` : path;
}

function samePath(left: string, right: string) {
  return left.trim().replace(/\\/g, "/").replace(/\/+$/, "") ===
    right.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function ProjectEditDialog({
  project,
  onClose,
  onSaved,
  onError,
}: {
  project: ProjectEditTarget;
  onClose: () => void;
  onSaved: (group: ProjectGroupRecord) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<ProjectGroupRecord | null>(null);
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState<string[]>(
    project.roots?.slice().sort((a, b) => a.position - b.position).map((root) => root.path) ??
      [project.path],
  );
  const [primaryPath, setPrimaryPath] = useState(project.path);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const folderPickerInFlightRef = useRef(false);
  const reportLoadError = useEffectEvent((error: unknown) => onError(error));

  useEffect(() => {
    let cancelled = false;
    void api
      .listProjectGroups()
      .then(({ groups }) => {
        if (cancelled) return;
        const requestedPath = project.path;
        const resolved = groups.find(
          (candidate) =>
            (project.groupId && candidate.id === project.groupId) ||
            samePath(candidate.primaryPath, requestedPath) ||
            candidate.roots.some((root) => samePath(root.path, requestedPath)),
        );
        if (!resolved) {
          throw new Error(t("project.notFound", { defaultValue: "Project not found" }));
        }
        setGroup(resolved);
        setName(resolved.name);
        setPrimaryPath(resolved.primaryPath);
        setFolders(
          resolved.roots
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((root) => root.path),
        );
        setLoading(false);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoading(false);
          reportLoadError(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.groupId, project.path, t]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => inputRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const addFolders = async () => {
    if (busyRef.current || folderPickerInFlightRef.current) return;
    folderPickerInFlightRef.current = true;
    setFolderPickerBusy(true);
    try {
      const result = await api.pickProjectFolders();
      if (result.canceled || result.folders.length === 0) return;
      setFolders((current) => [
        ...current,
        ...result.folders.filter(
          (path) => !current.some((existing) => samePath(existing, path)),
        ),
      ]);
    } catch (error) {
      onError(error);
    } finally {
      folderPickerInFlightRef.current = false;
      setFolderPickerBusy(false);
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!group || loading || !trimmedName || busyRef.current) return;
    if (folders.length === 0 || !folders.some((path) => samePath(path, primaryPath))) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.updateProjectGroup(group.id, trimmedName, folders);
      onSaved(result.group);
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const dialog = (
    <div
      className="overlay project-create-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog project-create-dialog project-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-edit-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-create-dialog-head">
          <div className="project-create-dialog-heading">
            <h2 id="project-edit-dialog-title" className="project-create-dialog-title">
              {t("project.editTitle")}
            </h2>
            <p className="project-edit-dialog-description">{t("project.editDescription")}</p>
          </div>
          <TooltipButton
            type="button"
            className="project-create-dialog-close"
            tooltip={t("project.editCancel")}
            ariaLabel={t("project.editCancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={17} />
          </TooltipButton>
        </div>

        <form
          className="project-create-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="project-create-dialog-content">
            <section
              className="project-create-dialog-section project-create-dialog-identity"
              aria-labelledby="project-edit-name-heading"
            >
              <div className="project-create-dialog-section-head project-create-dialog-name-head">
                <label
                  id="project-edit-name-heading"
                  className="project-create-dialog-section-title project-create-dialog-field-label"
                  htmlFor="project-edit-name"
                >
                  {t("project.createNameLabel")}
                </label>
                <span className="project-create-dialog-name-count" aria-live="polite">
                  {name.length}/{MAX_PROJECT_NAME_CHARS}
                </span>
              </div>
              <input
                ref={inputRef}
                id="project-edit-name"
                className="field-input project-create-dialog-name-field"
                value={name}
                maxLength={MAX_PROJECT_NAME_CHARS}
                onChange={(event) => setName(event.target.value)}
                aria-label={t("project.createNameLabel")}
                disabled={loading || busy}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </section>

            <section
              className="project-create-dialog-section project-create-dialog-folders"
              aria-labelledby="project-edit-folders-heading"
            >
              <div className="project-create-dialog-section-head">
                <h3 id="project-edit-folders-heading" className="project-create-dialog-section-title">
                  {t("project.createFoldersLabel")}
                  {folders.length > 0 ? (
                    <span className="project-create-dialog-count">{folders.length}</span>
                  ) : null}
                </h3>
                <span className="project-create-dialog-source" data-project-source="local">
                  <IconMonitor size={15} aria-hidden />
                  {t("project.createComputer")}
                </span>
              </div>

              {folders.length > 0 ? (
                <div className="project-create-dialog-folder-list" role="list">
                  {folders.map((path) => {
                    const primary = samePath(path, primaryPath);
                    return (
                      <div
                        className={`project-create-folder-row${primary ? " is-primary" : ""}`}
                        key={path}
                        role="listitem"
                      >
                        <span className="project-create-folder-icon" aria-hidden>
                          <IconFolder size={17} />
                        </span>
                        <span className="project-create-folder-copy" title={path}>
                          <span className="project-create-folder-name">{folderName(path)}</span>
                          <span className="project-create-folder-path">{folderParent(path)}</span>
                        </span>
                        {primary ? (
                          <span className="project-create-primary-tag">
                            <IconStar size={11} fill="currentColor" aria-hidden />
                            {t("project.createPrimary")}
                          </span>
                        ) : null}
                        <TooltipButton
                          type="button"
                          className="project-create-folder-remove"
                          tooltip={
                            primary
                              ? t("project.editPrimaryLocked")
                              : t("project.createRemoveFolder")
                          }
                          ariaLabel={`${
                            primary
                              ? t("project.editPrimaryLocked")
                              : t("project.createRemoveFolder")
                          }: ${folderName(path)}`}
                          disabled={loading || busy || primary}
                          onClick={() =>
                            setFolders((current) =>
                              current.filter((item) => !samePath(item, path)),
                            )
                          }
                        >
                          <IconX size={15} />
                        </TooltipButton>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <button
                type="button"
                aria-label={t("project.createAddFolder")}
                className={`project-create-add-folder${folders.length === 0 ? " is-empty" : ""}`}
                onClick={() => void addFolders()}
                disabled={loading || busy || folderPickerBusy}
              >
                <span className="project-create-add-folder-icon" aria-hidden>
                  <IconNewProject size={18} />
                </span>
                <span className="project-create-add-folder-copy">
                  <span className="project-create-add-folder-title">
                    {t("project.createAddFolder")}
                  </span>
                </span>
              </button>
            </section>
          </div>

          <div className="project-create-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t("project.editCancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                loading ||
                !group ||
                !name.trim() ||
                folders.length === 0 ||
                !folders.some((path) => samePath(path, primaryPath)) ||
                busy
              }
            >
              {busy ? t("project.editSaving") : t("project.editAction")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
