import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectMemory, ProjectMemoryEntry } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { Button, Input, Textarea, TooltipButton } from "./ui";
import { IconClose, IconPlus, IconSparkles, IconTrash } from "./icons";

function newEntry(): ProjectMemoryEntry {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    "memory-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  return { id, title: "", content: "" };
}

function entriesFromMemory(memory: ProjectMemory): ProjectMemoryEntry[] {
  if (memory.entries) return memory.entries;
  return memory.content.trim()
    ? [{ id: "legacy-project-memory", title: "", content: memory.content.trim() }]
    : [];
}

function normalizeEntries(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return entries
    .map((entry) => ({
      id: entry.id.trim(),
      title: entry.title.trim(),
      content: entry.content.trim(),
    }))
    .filter((entry) => entry.content.length > 0);
}

function entriesEqual(left: ProjectMemoryEntry[], right: ProjectMemoryEntry[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  const [entries, setEntries] = useState<ProjectMemoryEntry[]>([]);
  const [savedEntries, setSavedEntries] = useState<ProjectMemoryEntry[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getProjectMemory(project.path).then((result) => {
      if (cancelled) return;
      const loadedEntries = entriesFromMemory(result.memory);
      setMemory(result.memory);
      setEntries(loadedEntries);
      setSavedEntries(loadedEntries);
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

  const updateEntry = (id: string, patch: Partial<ProjectMemoryEntry>) => {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  };

  const save = async () => {
    const normalized = normalizeEntries(entries);
    setSaving(true);
    try {
      const result = await api.saveProjectMemory(project.path, normalized);
      const saved = entriesFromMemory(result.memory);
      setMemory(result.memory);
      setEntries(saved);
      setSavedEntries(saved);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const dirty = memory !== null && !entriesEqual(entries, savedEntries);
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
        <div className="project-memory-dialog-toolbar">
          <span className="project-memory-dialog-count">
            {t("project.memoryCount", { count: entries.length })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={memory === null || saving}
            onClick={() => setEntries((current) => [...current, newEntry()])}
          >
            <IconPlus size={14} aria-hidden />
            {t("project.memoryAdd")}
          </Button>
        </div>
        {entries.length > 0 ? (
          <div className="project-memory-dialog-list" role="list">
            {entries.map((entry, index) => (
              <article className="project-memory-card" key={entry.id} role="listitem">
                <div className="project-memory-card-head">
                  <span className="project-memory-entry-index" aria-hidden>
                    {index + 1}
                  </span>
                  <Input
                    value={entry.title}
                    placeholder={t("project.memoryEntryTitle")}
                    aria-label={t("project.memoryEntryTitle")}
                    disabled={memory === null || saving}
                    onChange={(event) => updateEntry(entry.id, { title: event.target.value })}
                  />
                  <TooltipButton
                    type="button"
                    className="project-memory-remove"
                    tooltip={t("project.memoryRemove")}
                    ariaLabel={t("project.memoryRemove")}
                    disabled={saving}
                    onClick={() =>
                      setEntries((current) => current.filter((item) => item.id !== entry.id))
                    }
                  >
                    <IconTrash size={15} />
                  </TooltipButton>
                </div>
                <Textarea
                  className="project-memory-entry-content"
                  value={entry.content}
                  placeholder={t("project.memoryEntryContent")}
                  aria-label={t("project.memoryEntryContent")}
                  disabled={memory === null || saving}
                  onChange={(event) => updateEntry(entry.id, { content: event.target.value })}
                />
              </article>
            ))}
          </div>
        ) : (
          <div className="project-memory-dialog-empty">
            <IconSparkles size={20} aria-hidden />
            <span>{t("project.memoryEmpty")}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={memory === null || saving}
              onClick={() => setEntries([newEntry()])}
            >
              <IconPlus size={14} aria-hidden />
              {t("project.memoryAdd")}
            </Button>
          </div>
        )}
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
