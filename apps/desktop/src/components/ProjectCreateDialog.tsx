import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MAX_PROJECT_NAME_CHARS } from "../lib/sidebar-preferences";
import { api } from "../lib/api";
import { parseGitCloneUrl } from "../lib/git-clone-url";
import { useAppStore } from "../stores/app-store";
import { Button, TooltipButton } from "./ui";
import {
  IconBranch,
  IconClose,
  IconFolder,
  IconMonitor,
  IconNewProject,
  IconStar,
  IconX,
} from "./icons";

/** The Create project dialog creates from local folders or one git checkout. */
type ProjectSource = "local" | "git";

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

export function ProjectCreateDialog() {
  const { t } = useTranslation();
  const open = useAppStore((state) => state.createProjectDialogOpen);
  const close = useAppStore((state) => state.closeProjectDialog);
  const createProject = useAppStore((state) => state.createProjectFromFolders);
  const createProjectFromGit = useAppStore(
    (state) => state.createProjectFromGit,
  );
  const showToast = useAppStore((state) => state.showToast);
  const [source, setSource] = useState<ProjectSource>("local");
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [gitUrl, setGitUrl] = useState("");
  const [cloneParent, setCloneParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const folderPickerInFlightRef = useRef(false);
  // The repository name seeds the project name until the user types their own.
  const nameTouchedRef = useRef(false);
  const cloneTarget = parseGitCloneUrl(gitUrl);

  useEffect(() => {
    if (!open) return;
    setSource("local");
    setName("");
    setFolders([]);
    setGitUrl("");
    setCloneParent("");
    busyRef.current = false;
    folderPickerInFlightRef.current = false;
    nameTouchedRef.current = false;
    setBusy(false);
    setFolderPickerBusy(false);
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => inputRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) close();
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
  }, [close, open]);

  // A pasted repository URL names the project without stealing a typed name.
  useEffect(() => {
    if (source !== "git" || nameTouchedRef.current) return;
    setName(cloneTarget?.name ?? "");
  }, [cloneTarget?.name, source]);

  if (!open) return null;

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
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      folderPickerInFlightRef.current = false;
      setFolderPickerBusy(false);
    }
  };

  const chooseCloneParent = async () => {
    if (busyRef.current || folderPickerInFlightRef.current) return;
    folderPickerInFlightRef.current = true;
    setFolderPickerBusy(true);
    try {
      const result = await api.pickProjectFolders();
      if (result.canceled || result.folders.length === 0) return;
      setCloneParent(result.folders[0]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      folderPickerInFlightRef.current = false;
      setFolderPickerBusy(false);
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busyRef.current) return;
    if (source === "git") {
      if (!cloneTarget || !cloneParent) return;
    } else if (folders.length === 0) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (source === "git" && cloneTarget) {
        await createProjectFromGit({
          name: trimmedName,
          url: cloneTarget.url,
          parentPath: cloneParent,
        });
      } else {
        await createProject({
          name: trimmedName,
          folders,
          primaryPath: folders[0],
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
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
        if (event.target === event.currentTarget && !busyRef.current) close();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog project-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-create-dialog-head">
          <div className="project-create-dialog-heading">
            <h2 id="project-create-dialog-title" className="project-create-dialog-title">
              {t("project.createTitle")}
            </h2>
          </div>
          <TooltipButton
            type="button"
            className="project-create-dialog-close"
            tooltip={t("project.createCancel")}
            ariaLabel={t("project.createCancel")}
            disabled={busy}
            onClick={close}
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
              aria-labelledby="project-create-name-heading"
            >
              <div className="project-create-dialog-section-head project-create-dialog-name-head">
                <label
                  id="project-create-name-heading"
                  className="project-create-dialog-section-title project-create-dialog-field-label"
                  htmlFor="project-create-name"
                >
                  {t("project.createNameLabel")}
                </label>
                <span className="project-create-dialog-name-count" aria-live="polite">
                  {name.length}/{MAX_PROJECT_NAME_CHARS}
                </span>
              </div>
              <input
                ref={inputRef}
                id="project-create-name"
                className="field-input project-create-dialog-name-field"
                value={name}
                maxLength={MAX_PROJECT_NAME_CHARS}
                onChange={(event) => {
                  nameTouchedRef.current = true;
                  setName(event.target.value);
                }}
                aria-label={t("project.createNameLabel")}
                disabled={busy}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </section>

            <section
              className="project-create-dialog-section project-create-dialog-source-section"
              aria-labelledby="project-create-source-heading"
            >
              <div className="project-create-dialog-section-head">
                <h3
                  id="project-create-source-heading"
                  className="project-create-dialog-section-title"
                >
                  {t("project.createSourceLabel")}
                </h3>
              </div>
              <div
                className="project-create-dialog-source-options"
                role="group"
                aria-label={t("project.createSourceLabel")}
              >
                <button
                  type="button"
                  className={`project-create-dialog-source-option${
                    source === "local" ? " is-active" : ""
                  }`}
                  data-project-source="local"
                  aria-pressed={source === "local"}
                  disabled={busy}
                  onClick={() => setSource("local")}
                >
                  <IconMonitor size={15} aria-hidden />
                  {t("project.createComputer")}
                </button>
                <button
                  type="button"
                  className={`project-create-dialog-source-option${
                    source === "git" ? " is-active" : ""
                  }`}
                  data-project-source="git"
                  aria-pressed={source === "git"}
                  disabled={busy}
                  onClick={() => setSource("git")}
                >
                  <IconBranch size={15} aria-hidden />
                  {t("project.createSourceGit")}
                </button>
              </div>
            </section>

            {source === "local" ? (
              <section
                className="project-create-dialog-section project-create-dialog-folders"
                aria-labelledby="project-create-folders-heading"
              >
                <div className="project-create-dialog-section-head">
                  <h3 id="project-create-folders-heading" className="project-create-dialog-section-title">
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
                    {folders.map((path, index) => (
                      <div
                        className={`project-create-folder-row${index === 0 ? " is-primary" : ""}`}
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
                        {index === 0 ? (
                          <span className="project-create-primary-tag">
                            <IconStar size={11} fill="currentColor" aria-hidden />
                            {t("project.createPrimary")}
                          </span>
                        ) : null}
                        <TooltipButton
                          type="button"
                          className="project-create-folder-remove"
                          tooltip={t("project.createRemoveFolder")}
                          ariaLabel={`${t("project.createRemoveFolder")}: ${folderName(path)}`}
                          disabled={busy}
                          onClick={() => setFolders((current) => current.filter((item) => item !== path))}
                        >
                          <IconX size={15} />
                        </TooltipButton>
                      </div>
                    ))}
                  </div>
                ) : null}

                <button
                  type="button"
                  aria-label={t("project.createAddFolder")}
                  className={`project-create-add-folder${folders.length === 0 ? " is-empty" : ""}`}
                  onClick={() => void addFolders()}
                  disabled={busy || folderPickerBusy}
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
            ) : (
              <section
                className="project-create-dialog-section project-create-dialog-clone"
                aria-labelledby="project-create-clone-heading"
              >
                <div className="project-create-dialog-section-head">
                  <h3 id="project-create-clone-heading" className="project-create-dialog-section-title">
                    {t("project.createRepositoryLabel")}
                  </h3>
                  <span className="project-create-dialog-source" data-project-source="git">
                    <IconBranch size={15} aria-hidden />
                    {t("project.createSourceGit")}
                  </span>
                </div>

                <input
                  id="project-create-clone-url"
                  className="field-input project-create-dialog-url-field"
                  value={gitUrl}
                  placeholder={t("project.cloneUrlPlaceholder")}
                  aria-label={t("project.createRepositoryLabel")}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => setGitUrl(event.target.value)}
                />

                <button
                  type="button"
                  className={`project-create-dialog-location${
                    cloneParent ? " is-chosen" : ""
                  }`}
                  aria-label={t("project.createChooseLocation")}
                  onClick={() => void chooseCloneParent()}
                  disabled={busy || folderPickerBusy}
                >
                  <span className="project-create-dialog-location-icon" aria-hidden>
                    <IconFolder size={17} />
                  </span>
                  <span className="project-create-dialog-location-copy">
                    <span className="project-create-dialog-location-title">
                      {cloneParent
                        ? folderName(cloneParent)
                        : t("project.createChooseLocation")}
                    </span>
                    <span className="project-create-dialog-location-path">
                      {cloneParent
                        ? folderParent(cloneParent)
                        : t("project.createLocationHint")}
                    </span>
                  </span>
                </button>

                <p className="project-create-dialog-clone-hint" role="status">
                  {cloneTarget
                    ? t("project.cloneDestHint", { name: cloneTarget.name })
                    : t("project.cloneUrlHint")}
                </p>
              </section>
            )}
          </div>

          <div className="project-create-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t("project.createCancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                source === "git"
                  ? !name.trim() || !cloneTarget || !cloneParent || busy
                  : !name.trim() || folders.length === 0 || busy
              }
            >
              {busy
                ? source === "git"
                  ? t("project.cloning")
                  : t("project.createSaving")
                : source === "git"
                  ? t("project.cloneAction")
                  : t("project.createAction")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
