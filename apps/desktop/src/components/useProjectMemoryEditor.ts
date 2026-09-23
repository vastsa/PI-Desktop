import { useEffect, useRef, useState } from "react";
import type { ProjectMemoryEditor } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { cardsFromEditor, editorChanges, type EditorCard } from "./project-memory-editor-model";

function newCard(): EditorCard {
  const id = globalThis.crypto?.randomUUID?.() ??
    "memory-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  return { id, title: "", content: "" };
}

export function useProjectMemoryEditor(
  projectPath: string,
  onSaved: () => void,
  onError: (error: unknown) => void,
) {
  const [editor, setEditor] = useState<ProjectMemoryEditor | null>(null);
  const [cards, setCards] = useState<EditorCard[]>([]);
  const [saving, setSaving] = useState(false);
  // An editor request belongs to a particular mount/project load, not just a path.
  // A -> B -> A can otherwise accept a response from the first A.
  const generation = useRef(0);
  const loadedGeneration = useRef<number | null>(null);
  const loadedPath = useRef<string | null>(null);
  const pending = useRef<symbol | null>(null);
  const currentPath = useRef(projectPath);
  currentPath.current = projectPath;

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const isCurrent = () => generation.current === requestGeneration && currentPath.current === projectPath;
    loadedGeneration.current = null;
    loadedPath.current = null;
    pending.current = null;
    setSaving(false);
    setEditor(null);
    setCards([]);
    void api.getProjectMemoryEditor(projectPath).then(({ editor: result }) => {
      if (!isCurrent()) return;
      loadedGeneration.current = requestGeneration;
      loadedPath.current = projectPath;
      setEditor(result);
      setCards(cardsFromEditor(result));
    }).catch((error) => { if (isCurrent()) onError(error); });
    return () => {
      generation.current++;
      loadedGeneration.current = null;
      loadedPath.current = null;
      pending.current = null;
    };
  }, [projectPath]);

  const active = loadedGeneration.current === generation.current && loadedPath.current === projectPath &&
    currentPath.current === projectPath
    ? editor : null;
  const changes = active ? editorChanges(active, cards) : null;
  const dirty = changes !== null;
  const updateCard = (id: string, patch: Partial<EditorCard>) => {
    setCards((current) => current.map((item) =>
      item.id === id ? { ...item, ...patch } : item));
  };
  const removeCard = (id: string) => {
    setCards((current) => current.filter((item) => item.id !== id));
  };
  const addCard = () => setCards((current) => [...current, newCard()]);

  const save = async () => {
    if (!active || !changes || !dirty || pending.current) return;
    const requestGeneration = generation.current;
    const request = Symbol("save");
    pending.current = request;
    setSaving(true);
    const isCurrent = () => generation.current === requestGeneration &&
      currentPath.current === projectPath && pending.current === request;
    try {
      const { editor: next } = await api.saveProjectMemoryEditor(projectPath, {
        expectedOwner: active.owner,
        expectedMemory: active.memory,
        ...changes,
      });
      if (!isCurrent()) return;
      setEditor(next);
      setCards(cardsFromEditor(next));
      onSaved();
    } catch (error) {
      if (isCurrent()) onError(error);
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setSaving(false);
      }
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (!active || pending.current) return;
    const requestGeneration = generation.current;
    const request = Symbol("toggle");
    pending.current = request;
    setSaving(true);
    const isCurrent = () => generation.current === requestGeneration &&
      currentPath.current === projectPath && pending.current === request;
    try {
      const { autoRecordEnabled } = await api.setProjectAutoMemoryEnabled(projectPath, active.owner, enabled);
      if (!isCurrent()) return;
      // The switch is immediate, but unsaved editor baselines must stay intact.
      setEditor((current) => current ? {
        ...current, autoRecordEnabled,
      } : current);
      onSaved();
    } catch (error) {
      if (isCurrent()) onError(error);
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setSaving(false);
      }
    }
  };
  return {
    editor: active, cards: active ? cards : [], saving, dirty,
    updateCard, removeCard, addCard, save, setEnabled,
  };
}
