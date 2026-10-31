import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RemoteHostBrowseProjectsResult } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { OverlayBackdrop, Button, Field, Input, TooltipButton } from "../ui";
import { IconChevronRight, IconClose, IconFolder } from "../icons";

/** Directory navigation belongs to a separate modal, never the project form. */
export function RemoteFolderDialog({ hostKey, hostLabel, initialPath, onChoose, onClose }: {
  hostKey: string; hostLabel: string; initialPath: string;
  onChoose: (path: string) => void; onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const [directory, setDirectory] = useState<RemoteHostBrowseProjectsResult | null>(null);
  const [path, setPath] = useState(initialPath);
  const [browsing, setBrowsing] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const initialFocus = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  async function browse(nextPath?: string) {
    const request = ++generation.current;
    setBrowsing(true);
    setError("");
    try {
      const result = await api.remoteHostBrowseProjects(hostKey, nextPath);
      if (request !== generation.current) return;
      setDirectory(result);
      setPath(result.path);
    } catch (error) {
      if (request === generation.current) setError(t(remoteHostErrorKey(error)));
    } finally {
      if (request === generation.current) setBrowsing(false);
    }
  }

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
    void browse(initialPath.startsWith("/") ? initialPath : undefined);
    return () => {
      generation.current++;
      cancelAnimationFrame(frame);
      // The parent removes its inert state before focus is restored.
      requestAnimationFrame(() => { if (previouslyFocused?.isConnected) previouslyFocused.focus(); });
    };
  }, [hostKey]);

  useEffect(() => {
    if (browsing || !initialFocus.current) return;
    initialFocus.current = false;
    pathRef.current?.focus();
  }, [browsing]);

  const choose = () => {
    if (!directory || browsing || error || path !== directory.path) return;
    onChoose(directory.path);
  };
  const dialog = <OverlayBackdrop className="overlay remote-folder-dialog-overlay" role="presentation"
    onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div ref={dialogRef} className="dialog remote-folder-dialog" role="dialog" aria-modal="true"
      aria-labelledby="remote-folder-dialog-title" aria-describedby="remote-folder-dialog-host"
      onKeyDown={(event) => {
        // The project dialog also traps focus; only this foreground modal handles keys.
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="project-create-dialog-head">
        <div className="project-create-dialog-heading">
          <h2 id="remote-folder-dialog-title" className="project-create-dialog-title">{t("remote:folderPickerTitle")}</h2>
          <p id="remote-folder-dialog-host" className="project-edit-dialog-description">{hostLabel}</p>
        </div>
        <TooltipButton type="button" className="project-create-dialog-close" tooltip={t("project.createCancel")}
          ariaLabel={t("project.createCancel")} onClick={onClose}><IconClose size={17} /></TooltipButton>
      </div>
      <form className="remote-folder-dialog-navigation" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); if (path.startsWith("/") && !browsing) void browse(path); }}>
        <Field label={t("remote:folderPath")}>
          <div className="remote-folder-dialog-path-entry">
            <Input ref={pathRef} value={path} aria-label={t("remote:folderPath")} placeholder={t("remote:pathPlaceholder")}
              autoComplete="off" spellCheck={false} disabled={browsing} onChange={(event) => setPath(event.target.value)} />
            <Button type="submit" disabled={browsing || !path.startsWith("/")}>{t("remote:goToFolder")}</Button>
          </div>
        </Field>
        {path && !path.startsWith("/") ? <p className="remote-project-error" role="alert">{t("remote:REMOTE_ABSOLUTE_PATH_REQUIRED")}</p> : null}
        <Button type="button" variant="ghost" disabled={browsing || !directory?.parent}
          onClick={() => void browse(directory?.parent)}>{t("remote:parent")}</Button>
      </form>
      <div className="remote-folder-dialog-directory" aria-busy={browsing}>
        {browsing ? <p role="status">{t("remote:loading")}</p> : null}
        {error ? <p className="remote-project-error" role="alert">{error}</p> : null}
        {!browsing && directory && !error ? <>
          <p className="remote-project-browser-path" title={directory.path}>{directory.path}</p>
          <div className="remote-folder-dialog-entries" role="list" aria-label={t("remote:browseFolders")}>
            {directory.entries.map((entry) => <div role="listitem" key={entry.path}>
              <Button type="button" variant="ghost" className="remote-folder-dialog-entry"
                aria-label={t("remote:openFolder", { name: entry.name })} title={entry.path} onClick={() => void browse(entry.path)}>
                <IconFolder size={18} aria-hidden /><span>{entry.name}</span><IconChevronRight size={16} aria-hidden />
              </Button>
            </div>)}
          </div>
          {!directory.entries.length ? <p className="project-edit-dialog-description">{t("remote:emptyFolders")}</p> : null}
        </> : null}
      </div>
      <div className="project-create-dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose}>{t("project.createCancel")}</Button>
        <Button type="button" variant="primary" disabled={!directory || browsing || !!error || path !== directory.path} onClick={choose}>{t("remote:useFolder")}</Button>
      </div>
    </div>
  </OverlayBackdrop>;
  return createPortal(dialog, document.body);
}
