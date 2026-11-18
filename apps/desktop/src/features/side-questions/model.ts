import type { SessionSummary, UiMessage } from "@pi-desktop/shared";

export function sideQuestionReference(selection: string): { title: string; content: string } {
  const label = Array.from(selection.replace(/\s+/g, " ").trim());
  return { title: label.slice(0, 16).join("") + (label.length > 16 ? "…" : ""), content: selection };
}

/** The inherited snapshot is model context, not a second copy in the side-chat UI. */
export function sideQuestionMessages(messages: UiMessage[], inheritedCount: number, messageStart: number): UiMessage[] {
  return messages.slice(Math.max(0, inheritedCount - messageStart));
}

export function sideQuestionGroups(sessions: SessionSummary[]): Array<{ id: string; label: string; sessions: SessionSummary[] }> {
  const groups = new Map<string, { id: string; label: string; sessions: SessionSummary[] }>();
  for (const session of sessions) {
    const origin = session.sideQuestion;
    if (!origin) continue;
    const id = origin.throughMessageId ?? "";
    const group = groups.get(id) ?? { id, label: origin.anchorLabel, sessions: [] };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return [...groups.values()];
}
