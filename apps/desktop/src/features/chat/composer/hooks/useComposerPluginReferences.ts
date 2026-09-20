import type { useComposerAutocomplete } from "../../../../hooks/use-composer-autocomplete";
import { useEffect, useRef } from "react";
import { composerPluginRegistry, type PluginReference } from "../../../plugins/renderer/composer-registry";
import { createFileReference, isImageFilePath, nextChipToken } from "../editor";
import type { ComposerDraftController } from "./useComposerDraft";

function identity(reference: PluginReference): string {
  return JSON.stringify([reference.pluginId, reference.refId]);
}

export function useComposerPluginReferences(draft: ComposerDraftController, blocked: boolean, onInsert: () => void) {
  const current = useRef({ draft, blocked, onInsert });
  current.current = { draft, blocked, onInsert };
  const previous = useRef({ key: draft.draftKey, references: draft.activeFileReferences });
  useEffect(() => {
    if (previous.current.key === draft.draftKey) {
      const remaining = new Set(draft.activeFileReferences.filter((item) => item.pluginReference).map((item) => identity(item.pluginReference!)));
      for (const item of previous.current.references) {
        const reference = item.pluginReference;
        if (!reference || remaining.has(identity(reference))) continue;
        try { composerPluginRegistry.get(reference)?.provider.onRemove?.(reference); }
        catch (error) { console.warn(`[plugin:${reference.pluginId}] reference removal failed`, error); }
      }
    }
    previous.current = { key: draft.draftKey, references: draft.activeFileReferences };
  }, [draft.draftKey, draft.activeFileReferences]);

  const insert = (reference: PluginReference, text?: string, caret?: number) => {
    const { draft: live, blocked: inputBlocked } = current.current;
    if (inputBlocked || !reference.refId || !reference.label) return;
    const source = text ?? live.readLiveDraft();
    const at = caret ?? live.cursor;
    const references = live.fileReferencesRef.current;
    const existing = references.find((item) => item.sessionId === live.referenceSessionId && item.pluginReference && identity(item.pluginReference) === identity(reference) && item.token && source.includes(item.token));
    if (existing?.token) {
      live.applyEditorDraft(source, references, source.indexOf(existing.token) + existing.token.length);
      requestAnimationFrame(() => {
        const chip = Array.from(live.ref.current?.querySelectorAll<HTMLElement>(".composer-chip") ?? []).find((element) => element.dataset.token === existing.token);
        if (!chip) return;
        const range = document.createRange();
        range.selectNode(chip);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      return;
    }
    if (references.filter((item) => item.sessionId === live.referenceSessionId && item.pluginReference).length >= 64) return;
    current.current.onInsert();
    const token = nextChipToken();
    const item = createFileReference("", reference.label, live.referenceSessionId, { kind: "reference", token, pluginReference: reference });
    live.applyEditorDraft(source.slice(0, at) + token + source.slice(at), [...references, item], at + token.length);
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;
  useEffect(() => composerPluginRegistry.onInsert((reference) => insertRef.current(reference)), []);
  return (result: NonNullable<ReturnType<ReturnType<typeof useComposerAutocomplete>["accept"]>>) => {
    if (result.pluginReference) { insert(result.pluginReference, result.value, result.cursor); return; }
    const acceptedFileReference = result.fileReference;
    if (!acceptedFileReference) { draft.applyEditorDraft(result.value, draft.fileReferencesRef.current, result.cursor); return; }
    const token = nextChipToken();
    const nextText = result.value.slice(0, result.cursor) + token + result.value.slice(result.cursor);
    const reference = createFileReference(acceptedFileReference.path, acceptedFileReference.name, draft.referenceSessionId, {
      kind: isImageFilePath(acceptedFileReference.path) ? "image" : "file", token,
    });
    draft.applyEditorDraft(nextText, [...draft.fileReferencesRef.current, reference], result.cursor + token.length);
  };
}
