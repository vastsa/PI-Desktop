import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import {
  rewriteIdeographicCommaTrigger,
} from "@pi-desktop/shared";
import { useAppStore } from "../../../../stores/app-store";
import { api } from "../../../../lib/api";
import type { ComposerDraftSnapshot } from "../../../../lib/composer-smart-stop";
import {
  HOME_DRAFT_KEY,
  captureComposerDraft,
  deleteComposerDraft,
  draftKeyForSession,
  draftOwnerSessionId,
  flushScheduledHomeDraftAdopt,
  pruneComposerDrafts,
  readComposerDraft,
  writeComposerDraft,
} from "../../../../lib/composer-draft-cache";
import {
  editorSelectionRange,
  createFileReference,
  isEditableTextReference,
  isPersistedScratchReference,
  paintEditorValue,
  readEditorValue,
  setEditorCaret,
  type ComposerFileReference,
} from "../editor";
import type { ComposerPrefill } from "../model";

type ComposerSession = { id: string };

export type ComposerDraftController = {
  ref: RefObject<HTMLDivElement | null>;
  draftKey: string;
  referenceSessionId: string;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  valueRef: { current: string };
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  composing: boolean;
  setComposing: Dispatch<SetStateAction<boolean>>;
  inputFocused: boolean;
  setInputFocused: Dispatch<SetStateAction<boolean>>;
  placeholderIndex: number;
  fileReferences: ComposerFileReference[];
  setFileReferences: Dispatch<SetStateAction<ComposerFileReference[]>>;
  activeFileReferences: ComposerFileReference[];
  referenceByToken: Map<string, ComposerFileReference>;
  fileReferencesRef: { current: ComposerFileReference[] };
  referenceByTokenRef: { current: Map<string, ComposerFileReference> };
  removeChipByTokenRef: { current: (token: string) => void };
  updateCursor: (next: number) => void;
  handleInput: (source: string, caret: number) => string;
  readLiveDraft: () => string;
  persistDraft: (key?: string) => void;
  paintCurrentDraft: (element: HTMLElement, nextValue: string) => void;
  commitEditorDom: () => void;
  insertNewlineInEditor: () => void;
  applyEditorDraft: (
    nextText: string,
    nextReferences: ComposerFileReference[],
    caret: number,
  ) => void;
  snapshotReferences: (sourceSessionId: string) => ComposerDraftSnapshot["fileReferences"];
  draftSnapshot: (text: string) => ComposerDraftSnapshot;
  clearDraftForKey: (key: string) => void;
  restoreDraftForKey: (key: string, snapshot: ComposerDraftSnapshot) => void;
};

type UseComposerDraftOptions = {
  variant: "home" | "docked";
  activeSessionId: string | null | undefined;
  workspacePath: string;
  sessions: readonly ComposerSession[];
  composerPrefill: {
    sessionId: string;
    text: string;
    fileReferences: ComposerDraftSnapshot["fileReferences"];
  } | null;
  clearComposerPrefill: () => void;
  prefill?: ComposerPrefill | null;
  t: TFunction;
  invalidatePromptEnhancement: () => void;
  inputBlocked: boolean;
};

/**
 * Own the contenteditable draft lifecycle and its session-scoped cache.
 * Attachments and submission consume this controller instead of reaching into
 * the DOM or duplicating draft switching rules.
 */
export function useComposerDraft({
  variant,
  activeSessionId,
  workspacePath,
  sessions,
  composerPrefill,
  clearComposerPrefill,
  prefill,
  t,
  invalidatePromptEnhancement,
  inputBlocked,
}: UseComposerDraftOptions): ComposerDraftController {
  const draftKey = draftKeyForSession(activeSessionId);
  const referenceSessionId = activeSessionId ?? "";
  const initialDraft = readComposerDraft(draftKey);
  const [value, setValue] = useState(() => initialDraft?.text ?? "");
  const [fileReferences, setFileReferences] = useState<ComposerFileReference[]>(() =>
    (initialDraft?.fileReferences ?? []).map((fileReference) =>
      createFileReferenceFromSnapshot(fileReference, referenceSessionId),
    ),
  );
  const [cursor, setCursor] = useState(() => initialDraft?.text.length ?? 0);
  // `onSelect` fires on every caret move; avoid re-rendering for an unchanged
  // cursor so autocomplete trigger detection stays quiet.
  const updateCursor = (next: number) =>
    setCursor((current) => (current === next ? current : next));
  const [composing, setComposing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const placeholderContextRef = useRef(`${variant}:${activeSessionId ?? HOME_DRAFT_KEY}`);
  const draftKeyRef = useRef(draftKey);

  // Keep one guidance copy stable until the user changes page or session.
  useEffect(() => {
    const nextContext = `${variant}:${activeSessionId ?? HOME_DRAFT_KEY}`;
    if (placeholderContextRef.current === nextContext) return;
    placeholderContextRef.current = nextContext;
    setPlaceholderIndex((current) => (current + 1) % 3);
  }, [activeSessionId, variant]);

  const valueRef = useRef(value);
  valueRef.current = value;
  const fileReferencesRef = useRef(fileReferences);
  fileReferencesRef.current = fileReferences;
  const activeFileReferences = fileReferences.filter(
    (fileReference) => fileReference.sessionId === referenceSessionId,
  );
  const referenceByToken = useMemo(() => {
    const map = new Map<string, ComposerFileReference>();
    for (const fileReference of activeFileReferences) {
      if (fileReference.token) map.set(fileReference.token, fileReference);
    }
    return map;
  }, [activeFileReferences]);
  const referenceByTokenRef = useRef(referenceByToken);
  referenceByTokenRef.current = referenceByToken;
  const removeChipByTokenRef = useRef<(token: string) => void>(() => {});
  const expandTextReferenceRef = useRef<(token: string) => void>(() => {});
  const pendingEditorCaretRef = useRef<number | null>(
    initialDraft?.text ? initialDraft.text.length : null,
  );
  // `null` forces the first paint because React does not render children into
  // the contenteditable. Native typing keeps the value synchronized without
  // rewriting the DOM or disturbing the caret.
  const editorValueRef = useRef<string | null>(null);

  const readLiveDraft = () =>
    ref.current ? readEditorValue(ref.current) : valueRef.current;
  const persistDraft = (key = draftKeyRef.current) =>
    captureComposerDraft(key, readLiveDraft(), fileReferencesRef.current);

  const paintCurrentDraft = (element: HTMLElement, nextValue: string) => {
    paintEditorValue(
      element,
      nextValue,
      referenceByTokenRef.current,
      (name) => t("chat.removeFileReference", { name }),
      (token) => removeChipByTokenRef.current(token),
      (token) => expandTextReferenceRef.current(token),
    );
    editorValueRef.current = nextValue;
  };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || editorValueRef.current === value) return;
    paintCurrentDraft(element, value);
    const pendingCaret = pendingEditorCaretRef.current;
    if (pendingCaret !== null) {
      pendingEditorCaretRef.current = null;
      setEditorCaret(element, pendingCaret);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback closes over refs
  }, [value, referenceByToken]);

  useEffect(() => {
    const handler = () => {
      const element = ref.current;
      if (!element) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const anchor = selection.anchorNode;
      if (anchor && !element.contains(anchor)) return;
      const { start } = editorSelectionRange(element);
      updateCursor(start);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateCursor is stable
  }, []);

  const removeChipByToken = (token: string) => {
    const element = ref.current;
    if (!element) return;
    const source = readEditorValue(element);
    const index = source.indexOf(token);
    if (index === -1) return;
    const next = source.slice(0, index) + source.slice(index + 1);
    invalidatePromptEnhancement();
    // Leave the DOM value stale so the layout effect removes the chip.
    pendingEditorCaretRef.current = index;
    setValue(next);
    setCursor(index);
    setFileReferences((current) =>
      current.filter((fileReference) => fileReference.token !== token),
    );
  };
  removeChipByTokenRef.current = removeChipByToken;

  /** Commit a native contenteditable input while preserving IME correction. */
  const handleInput = (source: string, caret: number): string => {
    const nextValue =
      valueRef.current === ""
        ? rewriteIdeographicCommaTrigger(source)
        : source;
    invalidatePromptEnhancement();
    if (nextValue === source) {
      editorValueRef.current = nextValue;
    } else {
      // Leave the DOM value stale so the sync effect repaints the substituted
      // trigger and restores the caret after it.
      pendingEditorCaretRef.current = caret;
    }
    valueRef.current = nextValue;
    setValue(nextValue);
    setFileReferences((current) => {
      const next = current.filter(
        (fileReference) =>
          !fileReference.token || nextValue.includes(fileReference.token),
      );
      return next.length === current.length ? current : next;
    });
    updateCursor(caret);
    return nextValue;
  };

  /** Commit a manual DOM edit back into React state (no input event fires). */
  const commitEditorDom = () => {
    const element = ref.current;
    if (!element) return;
    const nextValue = readEditorValue(element);
    const { start } = editorSelectionRange(element);
    invalidatePromptEnhancement();
    editorValueRef.current = nextValue;
    valueRef.current = nextValue;
    setValue(nextValue);
    setFileReferences((current) => {
      const next = current.filter(
        (fileReference) =>
          !fileReference.token || nextValue.includes(fileReference.token),
      );
      return next.length === current.length ? current : next;
    });
    updateCursor(start);
  };

  /** Enter inserts a bare newline text node so the draft round-trips. */
  const insertNewlineInEditor = () => {
    const element = ref.current;
    if (!element) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    range.deleteContents();
    const node = document.createTextNode("\n");
    range.insertNode(node);
    const after = document.createRange();
    after.setStart(node, 1);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
    commitEditorDom();
  };

  useEffect(() => {
    const previousKey = draftKeyRef.current;
    if (previousKey !== draftKey) {
      invalidatePromptEnhancement();
      persistDraft(previousKey);
      if (previousKey === HOME_DRAFT_KEY) flushScheduledHomeDraftAdopt(draftKey);
      draftKeyRef.current = draftKey;
      const nextDraft = readComposerDraft(draftKey);
      setValue(nextDraft?.text ?? "");
      setFileReferences(
        nextDraft?.fileReferences.map((fileReference) =>
          createFileReferenceFromSnapshot(fileReference, referenceSessionId),
        ) ?? [],
      );
      setCursor(nextDraft?.text.length ?? 0);
      return;
    }
    // Current drafts are serialized lazily on switch, unmount, blur, or a
    // snapshot request; plain typing does not serialize on every keystroke.
  }, [draftKey, referenceSessionId]);

  useEffect(() => {
    captureComposerDraft(draftKey, valueRef.current, fileReferences);
  }, [draftKey, fileReferences, referenceSessionId]);

  useEffect(() => {
    pruneComposerDrafts([
      HOME_DRAFT_KEY,
      draftKey,
      ...sessions.map((session) => session.id),
    ]);
  }, [draftKey, sessions]);

  useLayoutEffect(() => {
    return () => {
      persistDraft(draftKeyRef.current);
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        persistDraft();
        return;
      }
      const element = ref.current;
      if (!element) return;
      const live = readEditorValue(element);
      const expected = valueRef.current;
      if (live === expected) return;
      if (!live && expected) {
        paintCurrentDraft(element, expected);
        setEditorCaret(element, expected.length);
        return;
      }
      commitEditorDom();
    };
    const onWindowBlur = () => persistDraft();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onWindowBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks close over refs
  }, []);

  useEffect(() => {
    const current = fileReferencesRef.current;
    const kept = current.filter((fileReference) =>
      isPersistedScratchReference(fileReference.path),
    );
    if (kept.length === current.length) return;
    const droppedTokens = new Set(
      current
        .filter((fileReference) => !isPersistedScratchReference(fileReference.path))
        .flatMap((fileReference) =>
          fileReference.token ? [fileReference.token] : [],
        ),
    );
    if (droppedTokens.size > 0) {
      const element = ref.current;
      const source = element ? readEditorValue(element) : valueRef.current;
      const caret = element ? editorSelectionRange(element).start : source.length;
      let nextValue = "";
      let nextCaret = caret;
      let index = 0;
      for (const char of Array.from(source)) {
        if (droppedTokens.has(char)) {
          if (index < caret) nextCaret -= char.length;
        } else {
          nextValue += char;
        }
        index += char.length;
      }
      const nextIndex = Math.max(0, Math.min(nextCaret, nextValue.length));
      pendingEditorCaretRef.current = nextIndex;
      setValue(nextValue);
      setCursor(nextIndex);
    }
    setFileReferences(kept);
  }, [workspacePath]);

  useEffect(() => {
    if (!composerPrefill || composerPrefill.sessionId !== activeSessionId) return;
    setValue(composerPrefill.text);
    setFileReferences((current) => [
      ...current.filter(
        (fileReference) => fileReference.sessionId !== composerPrefill.sessionId,
      ),
      ...composerPrefill.fileReferences.map((fileReference) =>
        createFileReferenceFromSnapshot(fileReference, composerPrefill.sessionId),
      ),
    ]);
    clearComposerPrefill();
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      setEditorCaret(element, readEditorValue(element).length);
    });
  }, [activeSessionId, composerPrefill, clearComposerPrefill]);

  useEffect(() => {
    if (!prefill?.text) return;
    setValue(prefill.text);
    setFileReferences([]);
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      setEditorCaret(element, readEditorValue(element).length);
    });
  }, [prefill]);

  const applyEditorDraft = (
    nextText: string,
    nextReferences: ComposerFileReference[],
    caret: number,
  ) => {
    pendingEditorCaretRef.current = caret;
    setValue(nextText);
    setCursor(caret);
    setFileReferences(nextReferences);
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      setEditorCaret(element, caret);
    });
  };

  const expandTextReference = async (token: string) => {
    if (inputBlocked) return;
    const reference = referenceByTokenRef.current.get(token);
    const editor = ref.current;
    if (!reference || !isEditableTextReference(reference) || !editor) return;
    if (!readEditorValue(editor).includes(token)) return;
    const sourceSessionId = reference.sessionId;
    try {
      const result = await api.fsRead(reference.path, reference.mimeType);
      if (result.kind !== "text" || result.content === undefined) {
        const message =
          result.kind === "tooLarge"
            ? t("panel.files.tooLarge")
            : result.kind === "binary"
              ? t("panel.files.binary")
              : t("panel.files.error");
        useAppStore.getState().showToast(message, { variant: "error" });
        return;
      }
      const liveEditor = ref.current;
      const liveReference = referenceByTokenRef.current.get(token);
      if (
        !liveEditor ||
        (useAppStore.getState().activeSessionId ?? "") !== sourceSessionId ||
        !liveReference ||
        liveReference.sessionId !== sourceSessionId ||
        liveReference.path !== reference.path
      ) {
        return;
      }
      const source = readEditorValue(liveEditor);
      const index = source.indexOf(token);
      if (index === -1) return;
      const nextText =
        source.slice(0, index) + result.content + source.slice(index + token.length);
      const nextReferences = fileReferencesRef.current.filter(
        (fileReference) => fileReference.token !== token,
      );
      invalidatePromptEnhancement();
      applyEditorDraft(nextText, nextReferences, index + result.content.length);
    } catch (error) {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
    }
  };
  expandTextReferenceRef.current = expandTextReference;

  const snapshotReferences = (sourceSessionId: string) =>
    fileReferencesRef.current
      .filter((fileReference) => fileReference.sessionId === sourceSessionId)
      .map(({ path, name, kind, mimeType, token }) => ({
        path,
        name,
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(token ? { token } : {}),
      }));

  const clearDraftForKey = (key: string) => {
    invalidatePromptEnhancement();
    deleteComposerDraft(key);
    const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
    if (currentKey !== key) return;
    valueRef.current = "";
    if (ref.current) paintCurrentDraft(ref.current, "");
    setValue("");
    const owner = draftOwnerSessionId(key);
    setFileReferences((current) =>
      current.filter((fileReference) => fileReference.sessionId !== owner),
    );
    setCursor(0);
  };

  const restoreDraftForKey = (key: string, snapshot: ComposerDraftSnapshot) => {
    const currentActiveSessionId = useAppStore.getState().activeSessionId;
    const currentKey = draftKeyForSession(currentActiveSessionId);
    if (currentKey !== key) {
      if (!readComposerDraft(key)?.text) writeComposerDraft(key, snapshot);
      return;
    }
    if (valueRef.current.trim()) return;
    const sessionId = currentActiveSessionId ?? "";
    setValue(snapshot.text);
    setFileReferences((current) => [
      ...current.filter((fileReference) => fileReference.sessionId !== sessionId),
      ...snapshot.fileReferences.map((fileReference) =>
        createFileReferenceFromSnapshot(fileReference, sessionId),
      ),
    ]);
    setCursor(snapshot.text.length);
  };

  const draftSnapshot = (text: string): ComposerDraftSnapshot => ({
    text: text.trim(),
    fileReferences: activeFileReferences
      .filter(
        (fileReference) =>
          !fileReference.token || text.includes(fileReference.token),
      )
      .map(({ path, name, kind, mimeType, token }) => ({
        path,
        name,
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(token ? { token } : {}),
      })),
  });

  return {
    ref,
    draftKey,
    referenceSessionId,
    value,
    setValue,
    valueRef,
    cursor,
    setCursor,
    composing,
    setComposing,
    inputFocused,
    setInputFocused,
    placeholderIndex,
    fileReferences,
    setFileReferences,
    activeFileReferences,
    referenceByToken,
    fileReferencesRef,
    referenceByTokenRef,
    removeChipByTokenRef,
    updateCursor,
    handleInput,
    readLiveDraft,
    persistDraft,
    paintCurrentDraft,
    commitEditorDom,
    insertNewlineInEditor,
    applyEditorDraft,
    snapshotReferences,
    draftSnapshot,
    clearDraftForKey,
    restoreDraftForKey,
  };
}

function createFileReferenceFromSnapshot(
  fileReference: ComposerDraftSnapshot["fileReferences"][number],
  sessionId: string,
): ComposerFileReference {
  return createFileReference(
    fileReference.path,
    fileReference.name,
    sessionId,
    fileReference,
  );
}
