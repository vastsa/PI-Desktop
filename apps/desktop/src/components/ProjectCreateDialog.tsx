import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { MAX_PROJECT_NAME_CHARS } from "../lib/sidebar-preferences";
import { api } from "../lib/api";
import { parseGitCloneUrl } from "../lib/git-clone-url";
import { allowInsecureUserEndpoints } from "@pi-desktop/shared";
import {
  defaultProjectName,
  folderNameFromPath,
  resolveProjectName,
} from "../lib/project-name";
import { useAppStore } from "../stores/app-store";
import { OverlayBackdrop, Button, Input, TooltipButton } from "./ui";
import { ProjectFolderPicker } from "./ProjectFolderPicker";
import { RemoteProjectPicker, type RemoteProjectSelection } from "./remote/RemoteProjectPicker";
import {
  IconBranch,
  IconClose,
  IconFolder,
  IconMonitor,
} from "./icons";

/** One project entry point for local folders, git checkouts and remote hosts. */
type ProjectSource = "local" | "git" | "remote";

function pathParts(path: string) {
  return path.split(/[\\/]/).filter(Boolean);
}

function folderParent(path: string) {
  const parts = pathParts(path);
  return parts.length > 1 ? `…/${parts.slice(-2, -1)[0]}` : path;
}

function samePath(left: string, right: string) {
  return left.trim().replace(/\\/g, "/").replace(/\/+$/, "") ===
    right.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// The create dialog mounts its content only while open: the blocking overlay
// registers with that mounted subtree, and every reopen resets the form.
export function ProjectCreateDialog() {
  const { t } = useTranslation();
  const open = useAppStore((state) => state.createProjectDialogOpen);
  const initialRemoteHostKey = useAppStore((state) => state.createProjectDialogRemoteHostKey);
  if (open) {
    return <ProjectCreateDialogContent initialRemoteHostKey={initialRemoteHostKey} />;
  }
  return null;
}

function ProjectCreateDialogContent({ initialRemoteHostKey }: { initialRemoteHostKey?: string }) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const close = useAppStore((state) => state.closeProjectDialog);
  const createProject = useAppStore((state) => state.createProjectFromFolders);
  const createProjectFromGit = useAppStore(
    (state) => state.createProjectFromGit,
  );
  const showToast = useAppStore((state) => state.showToast);
  const [source, setSource] = useState<ProjectSource>(initialRemoteHostKey ? "remote" : "local");
  const createProjectFromRemote = useAppStore((state) => state.createProjectFromRemote);
  const [remoteBrowseOpen, setRemoteBrowseOpen] = useState(false);
  const [remoteProject, setRemoteProject] = useState<RemoteProjectSelection | null>(null);
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
  // The picked source seeds the project name until the user types their own.
  const nameTouchedRef = useRef(false);
  const settings = useAppStore((state) => state.settings);
  const cloneTarget = parseGitCloneUrl(gitUrl, {
    allowInsecureHttp: allowInsecureUserEndpoints(settings),
  });
  const defaultName = defaultProjectName({
    source: source === "remote" ? "local" : source,
    folders: source === "remote" && remoteProject ? [remoteProject.path] : folders,
    repositoryName: cloneTarget?.name,
  });
  const projectName = resolveProjectName(name, defaultName);

  useEffect(() => {
    setSource(initialRemoteHostKey ? "remote" : "local");
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
        'input:not([disabled]), button:not([disabled]), select:not([disabled])',
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
  }, [close, initialRemoteHostKey]);

  // The first folder or the repository name fills the field until the user
  // types their own name; an emptied field still falls back to it on submit.
  useEffect(() => {
    if (nameTouchedRef.current) return;
    setName(defaultName);
  }, [defaultName]);

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
    const projectName = resolveProjectName(name, defaultName);
    if (busyRef.current) return;
    if (!projectName || (source === "remote" && !remoteProject)) return;
    if (source === "git") {
      if (!cloneTarget || !cloneParent) return;
    } else if (source === "local" && folders.length === 0) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (source === "remote" && remoteProject) {
        await createProjectFromRemote({ name: projectName, hostKey: remoteProject.hostKey, path: remoteProject.path });
      } else if (source === "git" && cloneTarget) {
        await createProjectFromGit({
          name: projectName,
          url: cloneTarget.url,
          parentPath: cloneParent,
        });
      } else {
        await createProject({
          name: projectName,
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
    <OverlayBackdrop
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
        aria-modal={remoteBrowseOpen ? undefined : true}
        aria-hidden={remoteBrowseOpen || undefined}
        inert={remoteBrowseOpen || undefined}
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
              <Input
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
                <Button
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
                </Button>
                <Button
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
                </Button>
                <Button type="button" className={`project-create-dialog-source-option${source === "remote" ? " is-active" : ""}`}
                  data-project-source="remote" aria-pressed={source === "remote"} disabled={busy}
                  onClick={() => setSource("remote")}>
                  <IconMonitor size={15} aria-hidden />{t("remote:remote")}
                </Button>
              </div>
            </section>

            {source === "remote" ? (
              <RemoteProjectPicker busy={busy} initialHostKey={initialRemoteHostKey} onChange={setRemoteProject} onBrowsingChange={setRemoteBrowseOpen} />
            ) : source === "local" ? (
              <ProjectFolderPicker folders={folders} busy={busy} pickerBusy={folderPickerBusy}
                onAdd={() => void addFolders()}
                onRemove={(path) => setFolders((current) => current.filter((item) => item !== path))} />
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

                <Input
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

                <Button
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
                        ? folderNameFromPath(cloneParent)
                        : t("project.createChooseLocation")}
                    </span>
                    <span className="project-create-dialog-location-path">
                      {cloneParent
                        ? folderParent(cloneParent)
                        : t("project.createLocationHint")}
                    </span>
                  </span>
                </Button>

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
                source === "remote" ? !projectName || !remoteProject || busy : source === "git"
                  ? !projectName || !cloneTarget || !cloneParent || busy
                  : !projectName || folders.length === 0 || busy
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
    </OverlayBackdrop>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
