import { useSyncExternalStore } from "react";

export interface ChatContextChip {
  id: string;
  title: string;
  content: string;
}

const chipsByKey = new Map<string, ChatContextChip[]>();
const listeners = new Set<() => void>();
const EMPTY: ChatContextChip[] = [];

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function setChips(key: string, chips: ChatContextChip[]): void {
  if (chips.length === 0) chipsByKey.delete(key);
  else chipsByKey.set(key, chips);
  notify();
}

export function attachChatContextChip(
  key: string,
  chip: Omit<ChatContextChip, "id">,
  id: string = globalThis.crypto?.randomUUID?.() ?? `ctx-${Date.now()}-${Math.random()}`,
): void {
  const chips = chipsByKey.get(key) ?? [];
  const index = chips.findIndex((existing) => existing.id === id);
  if (index < 0) {
    setChips(key, [...chips, { ...chip, id }]);
  } else if (chips[index].title !== chip.title || chips[index].content !== chip.content) {
    setChips(key, chips.map((existing, i) => i === index ? { ...chip, id } : existing));
  }
}

export function removeChatContextChip(key: string, id: string): void {
  setChips(
    key,
    (chipsByKey.get(key) ?? []).filter((chip) => chip.id !== id),
  );
}

export function clearChatContextChips(key: string, submitted?: readonly ChatContextChip[]): void {
  // A completed send must not remove references attached or replaced while it waited.
  setChips(key, submitted ? (chipsByKey.get(key) ?? []).filter(chip =>
    !submitted.some(previous => previous.id === chip.id && previous.title === chip.title && previous.content === chip.content)) : []);
}

export function useChatContextChips(key: string): ChatContextChip[] {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => chipsByKey.get(key) ?? EMPTY,
    () => EMPTY,
  );
}
