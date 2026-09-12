import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectMemory } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { Button, Textarea, TooltipButton } from "./ui";
import { IconClose, IconSparkles } from "./icons";

export function ProjectMemoryDialog({
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
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getProjectMemory(project.path).then((result) => {
      if (cancelled) return;
      setMemory(result.memory);
      setDraft(result.memory.content);
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
      const result = await api.saveProjectMemory(project.path, draft);
      setMemory(result.memory);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const dirty = memory !== null && draft !== memory.content;
  const dialog = (
    <div
      className="overlay project-instructions-dialog-overlay"
      role="presentation"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="dialog project-instructions-dialog project-memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-memory-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h3 id="project-memory-dialog-title" className="project-instructions-dialog-title">
              <IconSparkles size={17} aria-hidden />
              {t("project.editMemory")}
            </h3>
            <div className="project-instructions-dialog-project">{project.name}</div>
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("settings.cancel")}
            ariaLabel={t("settings.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <p className="project-memory-dialog-description">{t("project.memoryDescription")}</p>
        <Textarea
          className="settings-instruction-editor project-instructions-dialog-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("project.memoryPlaceholder")}
          aria-label={t("project.editMemory")}
          disabled={memory === null || saving}
        />
        <div className="project-memory-dialog-hint">{t("project.memoryHint")}</div>
        <div className="project-instructions-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("project.memorySaving") : t("project.memorySave")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
