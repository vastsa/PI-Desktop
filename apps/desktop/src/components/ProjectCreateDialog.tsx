import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MAX_PROJECT_NAME_CHARS } from "../lib/sidebar-preferences";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Button, TooltipButton } from "./ui";
import {
  IconClose,
  IconFolder,
  IconFolderOpen,
  IconMonitor,
  IconNewProject,
  IconSparkles,
  IconStar,
  IconX,
} from "./icons";

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
  const showToast = useAppStore((state) => state.showToast);
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setFolders([]);
    busyRef.current = false;
    setBusy(false);
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

  if (!open) return null;

  const addFolders = async () => {
    if (busyRef.current) return;
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
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || folders.length === 0 || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await createProject({
        name: trimmedName,
        folders,
        primaryPath: folders[0],
      });
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
        aria-describedby="project-create-memory-hint"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-create-dialog-head">
          <div className="project-create-dialog-heading">
            <span className="project-create-dialog-mark" aria-hidden>
              <IconNewProject size={21} />
            </span>
            <div className="project-create-dialog-heading-copy">
              <span className="project-create-dialog-kicker">{t("project.title")}</span>
              <h2 id="project-create-dialog-title" className="project-create-dialog-title">
                {t("project.createTitle")}
              </h2>
              <div id="project-create-memory-hint" className="project-create-dialog-memory-hint">
                <IconSparkles size={14} aria-hidden />
                <span>{t("project.createMemoryHint")}</span>
              </div>
            </div>
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
              className="project-create-dialog-panel project-create-dialog-identity"
              aria-labelledby="project-create-name-heading"
            >
              <div className="project-create-dialog-panel-head">
                <span className="project-create-dialog-step" aria-hidden>
                  01
                </span>
                <label
                  id="project-create-name-heading"
                  className="project-create-dialog-panel-title project-create-dialog-field-label"
                  htmlFor="project-create-name"
                >
                  {t("project.createNameLabel")}
                </label>
                <span className="project-create-dialog-name-count" aria-live="polite">
                  {name.length}/{MAX_PROJECT_NAME_CHARS}
                </span>
              </div>
              <div className="project-create-dialog-name-field">
                <span className="project-create-dialog-name-icon" aria-hidden>
                  <IconFolder size={18} />
                </span>
                <input
                  ref={inputRef}
                  id="project-create-name"
                  value={name}
                  maxLength={MAX_PROJECT_NAME_CHARS}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("project.createNamePlaceholder")}
                  aria-label={t("project.createNameLabel")}
                  disabled={busy}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </div>
              <div className="project-create-dialog-panel-footnote">
                <IconFolderOpen size={14} aria-hidden />
                <span>{t("project.createAddFolderHint")}</span>
              </div>
            </section>

            <section
              className="project-create-dialog-panel project-create-dialog-folders"
              aria-labelledby="project-create-folders-heading"
            >
              <div className="project-create-dialog-section-head">
                <div className="project-create-dialog-section-heading">
                  <span className="project-create-dialog-step" aria-hidden>
                    02
                  </span>
                  <h3 id="project-create-folders-heading" className="project-create-dialog-section-title">
                    {t("project.createFoldersLabel")}
                    {folders.length > 0 ? (
                      <span className="project-create-dialog-count">{folders.length}</span>
                    ) : null}
                  </h3>
                </div>
                <span className="project-create-dialog-location">
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
                disabled={busy}
              >
                <span className="project-create-add-folder-icon" aria-hidden>
                  <IconNewProject size={18} />
                </span>
                <span className="project-create-add-folder-copy">
                  <span className="project-create-add-folder-title">
                    {t("project.createAddFolder")}
                  </span>
                  <span className="project-create-add-folder-hint">
                    {t("project.createAddFolderHint")}
                  </span>
                </span>
              </button>
            </section>
          </div>

          <div className="project-create-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t("project.createCancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim() || folders.length === 0 || busy}
            >
              {busy ? t("project.createSaving") : t("project.createAction")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
