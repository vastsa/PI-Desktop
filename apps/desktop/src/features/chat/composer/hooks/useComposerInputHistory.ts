import { useEffect, useRef } from "react";
import type { ComposerDraftSnapshot } from "../../../../lib/composer-smart-stop";
import {
  loadComposerInputHistory,
  rememberComposerInput,
  type ComposerHistoryEntry,
} from "../../../../lib/composer-input-history";
import { createFileReference } from "../editor";
import { runHistoryStep, type HistoryDirection } from "../input-history";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerInputHistoryOptions = {
  draftKey: string;
  /** Conversation whose history is recalled; "" for the empty home composer. */
  referenceSessionId: string;
  draft: Pick<
    ComposerDraftController,
    "readLiveDraft" | "fileReferencesRef" | "applyEditorDraft" | "draftRevision"
  >;
};

export type ComposerInputHistoryController = {
  /** Returns true when the key was consumed by history navigation. */
  navigate: (direction: HistoryDirection) => boolean;
  exitBrowsing: () => void;
  record: (snapshot: ComposerDraftSnapshot, sessionId: string) => void;
};

/**
 * Terminal-style recall of the accepted submissions of one conversation.
 * Browsing starts only from an empty draft; any edit, submission, or session
 * switch ends it so the arrows go back to native caret movement. The step itself
 * lives in `runHistoryStep`.
 */
export function useComposerInputHistory({
  draftKey,
  referenceSessionId,
  draft,
}: UseComposerInputHistoryOptions): ComposerInputHistoryController {
  const indexRef = useRef<number | null>(null);
  const entriesRef = useRef<readonly ComposerHistoryEntry[]>([]);
  /** Draft revision the entry on screen was applied at. */
  const appliedRevisionRef = useRef(-1);

  const exitBrowsing = () => {
    indexRef.current = null;
    entriesRef.current = [];
  };

  useEffect(() => {
    exitBrowsing();
  }, [draftKey]);

  const navigate = (direction: HistoryDirection): boolean => {
    // Every real draft change marks a revision, so a revision that moved on its
    // own means the user edited the recalled entry behind our back (typing,
    // dictation, an attachment). A submit calls `exitBrowsing` up front.
    const edited =
      indexRef.current !== null &&
      draft.draftRevision(draftKey) !== appliedRevisionRef.current;
    const result = runHistoryStep({
      entries: entriesRef.current,
      index: indexRef.current,
      // A browse starts from an empty draft and every step replaces it, so this
      // only ever keeps leftovers of a previous conversation in the same slot.
      keptReferences: draft.fileReferencesRef.current.filter(
        (reference) => reference.sessionId !== referenceSessionId,
      ),
      direction,
      draftEmpty:
        !draft.readLiveDraft().trim() &&
        !draft.fileReferencesRef.current.some(
          (reference) => reference.sessionId === referenceSessionId,
        ),
      edited,
      loadHistory: () => loadComposerInputHistory(referenceSessionId),
      createReference: (reference) =>
        createFileReference(reference.path, reference.name, referenceSessionId, reference),
      effects: {
        applyDraft: (text, references, caret) =>
          draft.applyEditorDraft(text, [...references], caret),
      },
    });
    entriesRef.current = result.entries;
    indexRef.current = result.index;
    if (result.applied) appliedRevisionRef.current = draft.draftRevision(draftKey);
    return result.consumed;
  };

  const record = (snapshot: ComposerDraftSnapshot, sessionId: string) => {
    rememberComposerInput(sessionId, snapshot);
  };

  return { navigate, exitBrowsing, record };
}
