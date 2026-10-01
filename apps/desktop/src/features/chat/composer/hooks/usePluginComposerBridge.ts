/**
 * Lends this composer to the plugin draft bridge (`../plugins/draft-bridge.ts`)
 * while it is mounted, and tells the bridge after every render that changed
 * the draft, so plugin subscribers and the draft's generation follow it.
 */
import { useEffect, useRef, type RefObject } from "react";
import { api } from "../../../../lib/api";
import { editorSelectionRange, readEditorValue } from "../editor";
import type { ComposerFileReference } from "../model";
import { composerDraftBridge, type ComposerDraftHandle } from "../plugins/draft-bridge";

type BridgeSource = {
  ref: RefObject<HTMLDivElement | null>;
  draftKey: string;
  referenceSessionId: string;
  value: string;
  valueRef: { current: string };
  fileReferences: ComposerFileReference[];
  fileReferencesRef: { current: ComposerFileReference[] };
  inputBlocked: boolean;
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
  const handleRef = useRef<ComposerDraftHandle | null>(null);

  useEffect(() => {
    const text = () => {
      const { ref, valueRef } = latest.current;
      return ref.current ? readEditorValue(ref.current) : valueRef.current;
    };
    const handle: ComposerDraftHandle = {
      read() {
        const { inputBlocked, draftKey, referenceSessionId, fileReferencesRef } = latest.current;
        if (inputBlocked) return null;
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
        latest.current.applyEditorDraft(nextText, references, caret, focus);
      },
      async stage(sessionId, file) {
        const result = await api.pasteFiles(sessionId, [file]);
        const staged = result.files[0];
        if (!staged) throw new Error("the host staged no file");
        return staged;
      },
    };
    handleRef.current = handle;
    const unregister = composerDraftBridge.register(handle);
    return () => {
      handleRef.current = null;
      unregister();
    };
  }, []);

  const { value, fileReferences, draftKey, referenceSessionId, inputBlocked } = source;
  useEffect(() => {
    if (handleRef.current) composerDraftBridge.publish(handleRef.current);
  }, [value, fileReferences, draftKey, referenceSessionId, inputBlocked]);
}
