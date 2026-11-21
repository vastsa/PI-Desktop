/**
 * Lends this composer to the plugin draft bridge (`../plugins/draft-bridge.ts`)
 * and to the plugin suggestion slot (`../plugins/suggestion-bridge.ts`) while it
 * is mounted, and tells both after every render that changed the draft, so
 * plugin subscribers follow it, the draft's generation advances, and a
 * suggestion about an empty draft ends the moment the draft stops being empty.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { api } from "../../../../lib/api";
import { readComposerDraftRevision } from "../../../../lib/composer-draft-cache";
import { useAppStore } from "../../../../stores/app-store";
import { editorSelectionRange, readEditorValue } from "../editor";
import type { ComposerFileReference } from "../model";
import { composerDraftBridge } from "../plugins/draft-bridge";
import { composerSuggestion, type ComposerSuggestionHandle } from "../plugins/suggestion-bridge";

type BridgeSource = {
  ref: RefObject<HTMLDivElement | null>;
  draftKey: string;
  referenceSessionId: string;
  value: string;
  valueRef: { current: string };
  fileReferences: ComposerFileReference[];
  fileReferencesRef: { current: ComposerFileReference[] };
  composing: boolean;
  inputBlocked: boolean;
  enabled?: boolean;
  applyEditorDraft: (
    text: string,
    references: ComposerFileReference[],
    caret: number,
    focus?: boolean,
  ) => void;
};

export function usePluginComposerBridge(source: BridgeSource): void {
  const latest = useRef(source);
  latest.current = source;
  const handleRef = useRef<ComposerSuggestionHandle | null>(null);

  useEffect(() => {
    if (source.enabled === false) return;
    const text = () => {
      const { ref, valueRef } = latest.current;
      return ref.current ? readEditorValue(ref.current) : valueRef.current;
    };
    const handle: ComposerSuggestionHandle = {
      draftRevision: () => readComposerDraftRevision(latest.current.draftKey),
      canSuggest: () => latest.current.ref.current !== null && !latest.current.composing,
      read() {
        const { inputBlocked, draftKey, referenceSessionId, fileReferencesRef } = latest.current;
        if (inputBlocked || latest.current.enabled === false) return null;
        return {
          draftKey,
          sessionId: referenceSessionId,
          text: text(),
          references: fileReferencesRef.current,
        };
      },
      focused() {
        const element = latest.current.ref.current;
        return element !== null && document.activeElement === element;
      },
      selection() {
        const element = latest.current.ref.current;
        if (element) return editorSelectionRange(element);
        const end = text().length;
        return { start: end, end };
      },
      write(nextText, references, caret, focus) {
        if (latest.current.enabled === false || latest.current.inputBlocked) return;
        latest.current.applyEditorDraft(nextText, references, caret, focus);
      },
      async stage(sessionId, file) {
        if (latest.current.enabled === false || latest.current.inputBlocked || sessionId !== latest.current.referenceSessionId) {
          throw new Error("Composer attachment access unavailable");
        }
        const result = await api.pasteFiles(sessionId, [file]);
        const staged = result.files[0];
        if (!staged) throw new Error("the host staged no file");
        return staged;
      },
    };
    handleRef.current = handle;
    const unregister = composerDraftBridge.register(handle);
    composerSuggestion.selectSession(useAppStore.getState().activeSessionId ?? null);
    const unsubscribeSelection = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId) {
        composerSuggestion.selectSession(state.activeSessionId ?? null);
      }
    });
    // The suggestion slot needs the same handle: it reads the draft to decide
    // whether an offer fits and writes it when the user takes one.
    const unregisterSuggestion = composerSuggestion.register(handle);
    return () => {
      handleRef.current = null;
      unsubscribeSelection();
      unregisterSuggestion();
      unregister();
    };
  }, [source.enabled]);

  const { value, fileReferences, draftKey, referenceSessionId, inputBlocked, composing } = source;
  useLayoutEffect(() => {
    if (handleRef.current) composerSuggestion.publish(handleRef.current);
  }, [value, fileReferences, draftKey, referenceSessionId, inputBlocked, composing]);
  useEffect(() => {
    if (handleRef.current) composerDraftBridge.publish(handleRef.current);
  }, [value, fileReferences, draftKey, referenceSessionId, inputBlocked]);
}
