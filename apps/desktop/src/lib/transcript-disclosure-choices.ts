export type TranscriptDisclosureChoice = { open: boolean; revealRequest?: number; revision?: number };
type Choice = TranscriptDisclosureChoice;
export type DisclosureState = { disclosures: Map<string, Choice>; thinkingReveals: Map<string, Choice>; revision: number };
export function createDisclosureState(): DisclosureState {
  return { disclosures: new Map(), thinkingReveals: new Map(), revision: 0 };
}

/** Only explicit choices are retained; untouched nodes derive their defaults. */
export class DisclosureChoices {
  private choices: Map<string, Choice>;
  private listeners = new Map<string, Set<() => void>>();

  private state: DisclosureState;
  constructor(state = createDisclosureState()) {
    this.state = state;
    this.choices = state.disclosures;
  }

  get = (key: string, thinkingIds: readonly string[] = []): Choice | undefined => {
    let choice = this.choices.get(key);
    // A paged-in or regrouped ancestor follows the last explicit expansion of
    // its reasoning, unless the reader made a newer choice on that ancestor.
    for (const id of thinkingIds) {
      const reveal = this.state.thinkingReveals.get(id);
      if (reveal && (reveal.revision ?? 0) > (choice?.revision ?? 0)) choice = reveal;
    }
    return choice;
  };

  set(key: string, choice: Choice) {
    this.choices.set(key, { ...choice, revision: ++this.state.revision });
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  setThinking(messageIds: readonly string[], open: boolean) {
    if (!messageIds.length) return;
    const choice = { open, revision: ++this.state.revision };
    for (const id of messageIds) {
      const key = JSON.stringify(["thinking", id]);
      this.choices.set(key, { ...this.choices.get(key), ...choice });
      if (open) this.state.thinkingReveals.set(id, choice);
    }
    // Commit the whole batch before notifying mounted leaves and ancestors.
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener();
    }
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }
}
