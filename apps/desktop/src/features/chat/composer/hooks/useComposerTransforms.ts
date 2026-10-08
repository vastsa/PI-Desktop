import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  restoreInlineComposerFileReferenceTokens,
  stripInlineComposerFileReferenceTokens,
  type PluginComposerTransformMeta,
} from "@pi-desktop/shared";
import { api } from "../../../../lib/api";
import { draftKeyForSession } from "../../../../lib/composer-draft-cache";
import { useAppStore } from "../../../../stores/app-store";
import { setEditorCaret, type ComposerFileReference } from "../editor";

type DraftAccess = {
  ref: RefObject<HTMLDivElement | null>;
  setValue: (value: string) => void;
  setCursor: (cursor: number) => void;
};

type UndoState = {
  transform: PluginComposerTransformMeta;
  sourceText: string;
};

export type ComposerTransformController = {
  activeTransformKey: string | null;
  undo: UndoState | null;
  invalidate: () => void;
  run: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoLast: () => void;
};

export function composerTransformKey(
  transform: Pick<PluginComposerTransformMeta, "pluginId" | "id">,
): string {
  return `${transform.pluginId}/${transform.id}`;
}

export function useComposerTransforms(options: {
  transforms: PluginComposerTransformMeta[];
  value: string;
  draftKey: string;
  activeSessionId: string | null | undefined;
  providerId?: string;
  modelId?: string;
  sendBlocked: boolean;
  activeFileReferences: ComposerFileReference[];
  draft: DraftAccess;
  showToast: (message: string, options?: { variant?: "info" | "success" | "warning" | "error" }) => void;
}): ComposerTransformController {
  const {
    transforms,
    value,
    draftKey,
    activeSessionId,
    providerId,
    modelId,
    sendBlocked,
    activeFileReferences,
    draft,
    showToast,
  } = options;
  const [activeTransformKey, setActiveTransformKey] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const versionRef = useRef(0);
  const requestRef = useRef<symbol | null>(null);
  const transformsRef = useRef(transforms);
  transformsRef.current = transforms;

  const invalidate = () => {
    versionRef.current += 1;
    requestRef.current = null;
    setActiveTransformKey(null);
    setUndo(null);
  };

  useEffect(
    () => () => {
      versionRef.current += 1;
      requestRef.current = null;
    },
    [],
  );

  const run = async (transform: PluginComposerTransformMeta) => {
    const sourceText = value;
    const sourceSessionId = activeSessionId;
    const text = stripInlineComposerFileReferenceTokens(sourceText, activeFileReferences);
    const key = composerTransformKey(transform);
    if (!text.trim() || text.trim().startsWith("/") || sendBlocked || requestRef.current) return;
    if (!transformsRef.current.some((candidate) => composerTransformKey(candidate) === key)) return;

    const sourceDraftKey = draftKey;
    const sourceVersion = versionRef.current;
    const requestToken = Symbol("composer-transform");
    requestRef.current = requestToken;
    setActiveTransformKey(key);
    setUndo(null);
    try {
      const result = await api.runPluginComposerTransform({
        pluginId: transform.pluginId,
        id: transform.id,
        text,
        ...(providerId && modelId ? { modelKey: `${providerId}/${modelId}` } : {}),
      });
      const currentSessionId = useAppStore.getState().activeSessionId;
      if (
        requestRef.current !== requestToken ||
        currentSessionId !== sourceSessionId ||
        draftKeyForSession(currentSessionId) !== sourceDraftKey ||
        versionRef.current !== sourceVersion ||
        !transformsRef.current.some((candidate) => composerTransformKey(candidate) === key)
      ) {
        return;
      }
      const transformedText = result.trim();
      if (
        !transformedText ||
        !stripInlineComposerFileReferenceTokens(transformedText, activeFileReferences).trim()
      ) {
        throw Object.assign(new Error("The plugin returned an empty transformed draft."), {
          code: "PLUGIN_INVALID_RESULT",
        });
      }
      const nextText = restoreInlineComposerFileReferenceTokens(
        sourceText,
        transformedText,
        activeFileReferences,
      );
      versionRef.current += 1;
      draft.setValue(nextText);
      draft.setCursor(nextText.length);
      setUndo({ transform, sourceText });
      requestAnimationFrame(() => {
        const element = draft.ref.current;
        if (!element) return;
        element.focus();
        setEditorCaret(element, nextText.length);
      });
    } catch (error) {
      const currentSessionId = useAppStore.getState().activeSessionId;
      if (
        requestRef.current !== requestToken ||
        currentSessionId !== sourceSessionId ||
        draftKeyForSession(currentSessionId) !== sourceDraftKey ||
        versionRef.current !== sourceVersion ||
        !transformsRef.current.some((candidate) => composerTransformKey(candidate) === key)
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      showToast(`${transform.pluginName}: ${message}`, { variant: "error" });
    } finally {
      if (requestRef.current === requestToken) {
        requestRef.current = null;
        setActiveTransformKey(null);
      }
    }
  };

  const undoLast = () => {
    if (!undo) return;
    const sourceText = undo.sourceText;
    invalidate();
    draft.setValue(sourceText);
    draft.setCursor(sourceText.length);
    requestAnimationFrame(() => {
      const element = draft.ref.current;
      if (!element) return;
      element.focus();
      setEditorCaret(element, sourceText.length);
    });
  };

  return { activeTransformKey, undo, invalidate, run, undoLast };
}
