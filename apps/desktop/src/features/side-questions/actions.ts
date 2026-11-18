import { attachChatContextChip } from "../../lib/chat-context-chips";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { deleteComposerDraft, writeComposerDraft } from "../../lib/composer-draft-cache";
import { sideQuestionWorkPanelTab } from "../../lib/work-panel-tabs";
import { sideQuestionReference } from "./model";

/** A text selection is attached context, never a request to copy the source transcript. */
export async function openSideQuestion(parentId: string, title: string, selection?: string, prompt?: string): Promise<void> {
  const { session } = await api.createSideQuestion(parentId, prompt?.trim() ? Array.from(prompt.replace(/\s+/g, " ").trim()).slice(0, 80).join("") : title, { referenceOnly: selection !== undefined });
  useAppStore.getState().retainSideQuestion(session);
  if (selection !== undefined) attachChatContextChip(session.id, sideQuestionReference(selection));
  let failure: unknown;
  if (prompt?.trim()) {
    const key = session.id;
    writeComposerDraft(key, { text: prompt, fileReferences: [] });
    try {
      const result = await api.promptSideQuestion({ sessionId: session.id, content: prompt, viewingSessionId: null });
      if (!result.accepted) throw new Error("The side question was not accepted");
      deleteComposerDraft(key);
    } catch (error) { failure = error; }
  }
  useAppStore.getState().openWorkPanelTabForSession(parentId, sideQuestionWorkPanelTab(session.id, session.title));
  if (failure) throw failure;
}
