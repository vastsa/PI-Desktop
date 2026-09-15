import i18n from "i18next";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";
import { draftKeyForSession, readComposerDraft } from "../../lib/composer-draft-cache";
import { appendQuoteToDraft, buildQuoteText, quoteExcerpt } from "../../lib/chat-quotes";
import { annotationEditorFor, applyAnnotationComment } from "../../lib/response-annotations";

export function createAnnotationSlice({ get, set }: StoreAccess): Pick<AppState,
  "appendComposerDraftText" | "openResponseAnnotationEditor" | "saveResponseAnnotationEditor" | "closeResponseAnnotationEditor" | "removeResponseAnnotation" | "clearResponseAnnotations" | "quoteMessageIntoComposer"> {
  return {
    appendComposerDraftText: (text) => {
      const sessionId = get().activeSessionId;
      if (!sessionId || !text) return;
      // Read the live draft so a quote adds to what the user already typed. The
      // composer applies this prefill for its own session and then clears it (D209).
      const draft = readComposerDraft(draftKeyForSession(sessionId));
      set({
        composerPrefill: {
          sessionId,
          text: appendQuoteToDraft(draft?.text ?? "", text),
          fileReferences: draft?.fileReferences ?? [],
        },
      });
    },

    openResponseAnnotationEditor: ({ messageId, text, annotationId, anchor }) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const current = get().responseAnnotations[sessionId] ?? [];
      // An excerpt that is already attached reopens its own annotation for
      // editing. The excerpt is snapshotted here, before focus moves into the
      // editor and collapses the selection it came from.
      set({
        responseAnnotationEditor: annotationEditorFor(current, {
          sessionId,
          messageId,
          text,
          annotationId,
          anchor,
        }),
      });
    },

    saveResponseAnnotationEditor: (comment) => {
      const editor = get().responseAnnotationEditor;
      if (!editor) return;
      const current = get().responseAnnotations[editor.sessionId] ?? [];
      const next = applyAnnotationComment(
        current,
        editor,
        comment,
        crypto.randomUUID(),
      );
      set((state) => {
        // A save whose target was already sent or removed changes nothing; it
        // must not recreate the annotation.
        if (!next) return { responseAnnotationEditor: null };
        return {
          responseAnnotations: {
            ...state.responseAnnotations,
            [editor.sessionId]: next,
          },
          responseAnnotationEditor: null,
        };
      });
    },

    closeResponseAnnotationEditor: () => {
      if (!get().responseAnnotationEditor) return;
      set({ responseAnnotationEditor: null });
    },

    removeResponseAnnotation: (id) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const current = get().responseAnnotations[sessionId] ?? [];
      const next = current.filter((annotation) => annotation.id !== id);
      if (next.length === current.length) return;
      set((state) => {
        const responseAnnotations = { ...state.responseAnnotations };
        if (next.length === 0) delete responseAnnotations[sessionId];
        else responseAnnotations[sessionId] = next;
        return { responseAnnotations };
      });
    },

    clearResponseAnnotations: () => {
      const sessionId = get().activeSessionId;
      if (!sessionId || !get().responseAnnotations[sessionId]) return;
      set((state) => {
        const responseAnnotations = { ...state.responseAnnotations };
        delete responseAnnotations[sessionId];
        return { responseAnnotations };
      });
    },

    quoteMessageIntoComposer: ({ title, text, selection }) => {
      if (!get().activeSessionId) return;
      const excerpt = quoteExcerpt(text, selection ?? "");
      if (!excerpt) return;
      get().appendComposerDraftText(
        buildQuoteText(excerpt, i18n.t("chat.quoteSource", { title })),
      );
    },

  };
}
