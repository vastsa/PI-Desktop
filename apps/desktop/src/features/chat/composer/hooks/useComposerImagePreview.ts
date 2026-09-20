import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";
import { isImageReference } from "../image-attachments";
import type { ComposerFileReference } from "../model";

export type ComposerImageSource =
  | { status: "ready"; src: string }
  | { status: "loading" | "error"; src?: never };

type PreviewRequest = {
  id: string;
  sessionId: string;
  workspaceRoot: string | null;
  restoreFocus: () => void;
};

/** Own transient attachment reads and preview selection, independently of drafts. */
export function useComposerImagePreview({
  references,
  value,
  sessionId,
  editorRef,
}: {
  references: ComposerFileReference[];
  value: string;
  sessionId: string;
  editorRef: RefObject<HTMLDivElement | null>;
}) {
  const currentSessionId = useAppStore((s) => s.activeSessionId ?? "");
  const workspaceRoot = useAppStore((s) => s.workspace?.path ?? null);
  const images = useMemo(() => references.filter((reference) =>
    reference.sessionId === sessionId &&
    isImageReference(reference),
  ), [references, sessionId]);
  const [request, setRequest] = useState<PreviewRequest | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<{
    images: typeof images;
    workspaceRoot: string | null;
    sources: Map<string, ComposerImageSource>;
  } | null>(null);

  useEffect(() => {
    let current = true;
    const sources = new Map<string, ComposerImageSource>();
    const publish = () => {
      if (current) setLoaded({ images, workspaceRoot, sources: new Map(sources) });
    };
    publish();
    for (const reference of images) {
      void api.fsReadImageDataUrl(reference.path, reference.mimeType).then(
        (result) => {
          sources.set(reference.id, result.kind === "image" && result.dataUrl
            ? { status: "ready", src: result.dataUrl }
            : { status: "error" });
          publish();
        },
        () => {
          sources.set(reference.id, { status: "error" });
          publish();
        },
      );
    }
    return () => { current = false; };
  }, [images, workspaceRoot, generation]);

  const sources = loaded?.images === images && loaded.workspaceRoot === workspaceRoot
    ? loaded.sources : undefined;
  const visibleImages = images.filter((image) => !image.token || value.includes(image.token));
  const valid = request != null && request.sessionId === currentSessionId &&
    request.sessionId === sessionId && request.workspaceRoot === workspaceRoot &&
    visibleImages.some((image) => image.id === request.id);
  useEffect(() => { if (!valid) setRequest(null); }, [valid]);

  const open = useCallback((reference: ComposerFileReference) => {
    const store = useAppStore.getState();
    if (reference.sessionId !== (store.activeSessionId ?? "")) return;
    const editor = editorRef.current;
    if (!editor) return;
    const focused = document.activeElement;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const openingWorkspace = store.workspace?.path ?? null;
    setRequest({
      id: reference.id,
      sessionId: reference.sessionId,
      workspaceRoot: openingWorkspace,
      restoreFocus: () => {
        const current = useAppStore.getState();
        if (!editor.isConnected || (current.activeSessionId ?? "") !== reference.sessionId ||
          (current.workspace?.path ?? null) !== openingWorkspace) return;
        if (focused instanceof HTMLElement && focused.isConnected && (editor.contains(focused) || focused.closest(".composer-image-attachments"))) focused.focus();
        else editor.focus();
        if (range && editor.contains(range.commonAncestorContainer)) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      },
    });
  }, [editorRef]);
  const close = useCallback(() => setRequest(null), []);
  const select = useCallback((id: string) => setRequest((current) => current ? { ...current, id } : null), []);
  const retry = useCallback(() => setGeneration((current) => current + 1), []);
  return {
    images: visibleImages,
    sources,
    open,
    close,
    select,
    retry,
    preview: valid && request ? {
      ...request,
      images: visibleImages,
      source: sources?.get(request.id) ?? { status: "loading" } as ComposerImageSource,
    } : null,
  };
}

export type ComposerImagePreviewController = ReturnType<typeof useComposerImagePreview>;
