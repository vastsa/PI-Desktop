import type { ProjectMemory, ProjectMemoryEditor, ProjectMemoryEntry } from "@pi-desktop/shared";

export type EditorCard = ProjectMemoryEntry;

export function memoryEntries(memory: ProjectMemory): ProjectMemoryEntry[] {
  if (memory.entries) return memory.entries;
  return memory.content.trim()
    ? [{ id: "legacy-project-memory", title: "", content: memory.content.trim() }]
    : [];
}

export function cardsFromEditor(editor: ProjectMemoryEditor): EditorCard[] {
  return memoryEntries(editor.memory).map((entry) => ({ ...entry }));
}

export function editorChanges(editor: ProjectMemoryEditor, cards: EditorCard[]): {
  entries: ProjectMemoryEntry[];
} | null {
  if (JSON.stringify(cards) === JSON.stringify(memoryEntries(editor.memory))) return null;
  return { entries: cards.map(({ id, title, content }) => ({
    id: id.trim(), title: title.trim(), content: content.trim(),
  })).filter((entry) => entry.content.length > 0) };
}
