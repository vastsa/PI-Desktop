import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MAX_PROJECT_INSTRUCTIONS_BYTES } from "@pi-desktop/shared";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { api } from "../lib/api";
import { OverlayBackdrop, Button, Textarea, TooltipButton } from "./ui";
import { IconClose } from "./icons";

export function ProjectInstructionsDialog({ project, onClose, onSaved, onError }: {
  project: { name: string; path: string; groupId?: string; legacy?: boolean };
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const [document, setDocument] = useState<{ groupId: string; content: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const current = ++epoch.current;
    setDocument(null);
    const load = async () => {
      const groupId = project.groupId ?? (await api.listProjectGroups()).groups
        .find((group) => group.roots.some((root) => root.path === project.path))?.id;
      if (!groupId) throw new Error(t("project.notFound"));
      const { content } = await api.getProjectGroupInstructions(groupId);
      if (epoch.current !== current) return;
      setDocument({ groupId, content });
      setDraft(content);
    };
    void load().catch((error: unknown) => {
      if (epoch.current === current) errorRef.current(error);
    });
    return () => { epoch.current += 1; };
  }, [project.groupId, project.path, t]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const bytes = new TextEncoder().encode(draft).length;
  const save = async () => {
    if (!document || busyRef.current || bytes > MAX_PROJECT_INSTRUCTIONS_BYTES) return;
    const current = epoch.current;
    busyRef.current = true;
    setSaving(true);
    try {
      const result = await api.saveProjectGroupInstructions(document.groupId, draft);
      if (epoch.current !== current) return;
      setDocument({ ...document, content: result.content });
      onSaved();
    } catch (error) {
      if (epoch.current === current) onError(error);
    } finally {
      busyRef.current = false;
      if (epoch.current === current) setSaving(false);
    }
  };
  const dirty = document !== null && draft !== document.content;
  const dialog = <OverlayBackdrop className="overlay project-instructions-dialog-overlay" role="presentation"
    onClick={() => { if (!busyRef.current) onClose(); }}>
    <div className="dialog project-instructions-dialog" role="dialog" aria-modal="true"
      aria-labelledby="project-instructions-dialog-title" onClick={(event) => event.stopPropagation()}>
      <div className="project-instructions-dialog-head">
        <div><h3 id="project-instructions-dialog-title" className="project-instructions-dialog-title">{t("project.editInstructions")}</h3>
          <div className="project-instructions-dialog-project">{project.name}</div></div>
        <TooltipButton type="button" className="project-instructions-dialog-close" tooltip={t("settings.cancel")}
          ariaLabel={t("settings.cancel")} disabled={saving} onClick={onClose}><IconClose size={16} /></TooltipButton>
      </div>
      <p id="project-instructions-hint" className="project-instructions-dialog-path">{t("project.agentMarkdownHint")}</p>
      <Textarea className="settings-instruction-editor project-instructions-dialog-editor" value={draft}
        onChange={(event) => setDraft(event.target.value)} aria-label={t("project.editInstructions")}
        aria-describedby="project-instructions-hint project-instructions-bytes"
        aria-invalid={bytes > MAX_PROJECT_INSTRUCTIONS_BYTES || undefined} disabled={!document || saving} />
      <p id="project-instructions-bytes" role={bytes > MAX_PROJECT_INSTRUCTIONS_BYTES ? "alert" : undefined}>
        {t("project.agentBytes", { count: bytes, max: MAX_PROJECT_INSTRUCTIONS_BYTES })}</p>
      <div className="project-instructions-dialog-actions">
        <Button variant="ghost" disabled={saving} onClick={onClose}>{t("settings.cancel")}</Button>
        <Button variant="primary" disabled={!dirty || saving || bytes > MAX_PROJECT_INSTRUCTIONS_BYTES} onClick={() => void save()}>
          {saving ? t("settings.saving") : t("settings.instructionsSave")}</Button>
      </div>
    </div>
  </OverlayBackdrop>;
  return typeof window === "undefined" ? dialog : createPortal(dialog, window.document.body);
}
