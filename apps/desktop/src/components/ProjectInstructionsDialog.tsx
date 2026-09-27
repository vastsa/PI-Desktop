import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AgentInstructionFile } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { Button, Textarea } from "./ui";
import { IconClose } from "./icons";

export function ProjectInstructionsDialog({
  project,
  onClose,
  onSaved,
  onError,
}: {
  project: { name: string; path: string };
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<AgentInstructionFile | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getAgentInstructions(project.path).then((result) => {
      if (cancelled || !result.project) return;
      setFile(result.project);
      setDraft(result.project.content);
    }).catch((error) => {
      if (!cancelled) onError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.saveAgentInstructions("project", draft, project.path);
      setFile(result.file);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const dirty = file !== null && draft !== file.content;
  const dialog = (
    <div
      className="overlay project-instructions-dialog-overlay"
      role="presentation"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="dialog project-instructions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-instructions-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h3 id="project-instructions-dialog-title" className="project-instructions-dialog-title">
              {t("project.editInstructions")}
            </h3>
            <div className="project-instructions-dialog-project">{project.name}</div>
          </div>
          <button
            type="button"
            className="project-instructions-dialog-close"
            aria-label={t("settings.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="project-instructions-dialog-path">{file?.path ?? ""}</div>
        <Textarea
          className="settings-instruction-editor project-instructions-dialog-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t("project.editInstructions")}
          disabled={!file || saving}
        />
        <div className="project-instructions-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("settings.saving") : t("settings.instructionsSave")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}
