import {
  useState,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import type { TFunction } from "i18next";
import { materializeDraftSession, useAppStore } from "../../../../stores/app-store";
import { api } from "../../../../lib/api";
import {
  HOME_DRAFT_KEY,
  deleteComposerDraft,
  writeComposerDraft,
} from "../../../../lib/composer-draft-cache";
import {
  composerDropItems,
  hasComposerFileDrag,
  type ComposerDropItem,
} from "../../../../lib/composer-drop";
import type { ComposerDraftSnapshot } from "../../../../lib/composer-smart-stop";
import {
  clipboardFiles,
  createFileReference,
  editorSelectionRange,
  formatDroppedDirectoryPath,
  nextChipToken,
  readEditorValue,
  type ComposerFileReference,
} from "../editor";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerAttachmentsOptions = {
  inputBlocked: boolean;
  activeSessionId: string | null | undefined;
  draftKey: string;
  largePasteThreshold: number;
  t: TFunction;
  draft: Pick<
    ComposerDraftController,
    | "ref"
    | "valueRef"
    | "fileReferencesRef"
    | "applyEditorDraft"
    | "snapshotReferences"
    | "commitEditorDom"
  >;
};

export type ComposerAttachmentsController = {
  pasting: boolean;
  dropTargetActive: boolean;
  setDropTargetActive: (active: boolean) => void;
  droppedDirectories: ComposerDropItem[];
  pickAndAttach: () => Promise<void>;
  pasteClipboardFiles: (event: ClipboardEvent<HTMLDivElement>) => void;
  attachDroppedItems: (items: ComposerDropItem[]) => Promise<void>;
  onComposerDragEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  openDroppedFolderAsProject: () => Promise<void>;
  insertDroppedDirectoryPaths: () => void;
  dismissDroppedDirectories: () => void;
};

/**
 * Coordinate native file import, clipboard persistence, and folder drops.
 * This keeps asynchronous attachment work out of the composer container while
 * preserving the existing session-owned draft handoff rules.
 */
export function useComposerAttachments({
  inputBlocked,
  activeSessionId,
  draftKey,
  largePasteThreshold,
  t,
  draft,
}: UseComposerAttachmentsOptions): ComposerAttachmentsController {
  const [pasting, setPasting] = useState(false);
  const [dropTargetActive, setDropTargetActive] = useState(false);
  const [droppedDirectories, setDroppedDirectories] = useState<ComposerDropItem[]>([]);
  const isInputBlocked = inputBlocked || pasting;

  const snapshotReferences = (sourceSessionId: string) =>
    draft.snapshotReferences(sourceSessionId);

  const pickAndAttach = async () => {
    try {
      // The picker accepts regular files; the importer classifies images from
      // MIME/extension metadata after selection.
      const result = await api.pickFiles();
      if (result.canceled || !result.token || isInputBlocked) return;

      const editor = draft.ref.current;
      const sourceValue = editor ? readEditorValue(editor) : draft.valueRef.current;
      const { start: selectionStart, end: selectionEnd } = editor
        ? editorSelectionRange(editor)
        : { start: sourceValue.length, end: sourceValue.length };
      const sourceSessionId = activeSessionId;
      const sourceDraftKey = draftKey;
      const previousReferences = snapshotReferences(sourceSessionId ?? "");
      setPasting(true);
      try {
        // A picker action is real input, so a home draft gets a durable owner
        // before native paths are copied into scratch.
        const sessionId = sourceSessionId ?? (await materializeDraftSession());
        if (!sessionId) throw new Error("session unavailable");
        const imported = await api.importFiles(sessionId, result.token);
        const chips = imported.files.map((file) => {
          const token = nextChipToken();
          return {
            token,
            reference: createFileReference(file.path, file.name, sessionId, {
              kind: file.kind,
              mimeType: file.mimeType,
              token,
            }),
          };
        });
        if (!chips.length) return;
        const inserted = chips.map((chip) => chip.token).join("");
        const nextText =
          sourceValue.slice(0, selectionStart) +
          inserted +
          sourceValue.slice(selectionEnd);
        const nextReferences = [
          ...previousReferences.map((reference) =>
            createFileReference(reference.path, reference.name, sessionId, reference),
          ),
          ...chips.map((chip) => chip.reference),
        ];
        writeComposerDraft(sessionId, {
          text: nextText,
          fileReferences: [
            ...previousReferences,
            ...chips.map((chip) => toDraftReference(chip.reference)),
          ],
        });
        const currentSessionId = useAppStore.getState().activeSessionId;
        if (currentSessionId === sessionId) {
          draft.applyEditorDraft(nextText, nextReferences, selectionStart + inserted.length);
        } else if (sourceDraftKey === HOME_DRAFT_KEY) {
          deleteComposerDraft(HOME_DRAFT_KEY);
        }
        showToast(t, "chat.filesAttached", { count: chips.length }, "success");
      } finally {
        setPasting(false);
      }
    } catch (error) {
      showErrorToast(t, error);
    }
  };

  const pasteClipboardFiles = async (event: ClipboardEvent<HTMLDivElement>) => {
    if (isInputBlocked) return;
    const files = clipboardFiles(event.clipboardData);
    const text = event.clipboardData.getData("text/plain");
    const textLength = Array.from(text).length;
    const isLargeTextPaste = !files.length && textLength > largePasteThreshold;
    if (isLargeTextPaste || files.length) {
      event.preventDefault();
      const editor = event.currentTarget;
      const { start: selectionStart, end: selectionEnd } = editorSelectionRange(editor);
      const sourceValue = readEditorValue(editor);
      const sourceSessionId = activeSessionId;
      const sourceDraftKey = draftKey;
      setPasting(true);
      try {
        const payload = files.length
          ? await Promise.all(
              files.map(async (file) => ({
                name: file.name || undefined,
                mimeType: file.type || undefined,
                data: await file.arrayBuffer(),
              })),
            )
          : (() => {
              const bytes = new TextEncoder().encode(text);
              return [
                {
                  name: `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
                  mimeType: "text/plain",
                  recordHistory: true,
                  data: bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                  ) as ArrayBuffer,
                },
              ];
            })();
        let sessionId = sourceSessionId;
        if (!sessionId) sessionId = (await materializeDraftSession()) ?? "";
        if (!sessionId) throw new Error("session unavailable");

        const result = await api.pasteFiles(sessionId, payload);
        const chips = result.files.map((file) => {
          const token = nextChipToken();
          return {
            token,
            reference: createFileReference(file.path, file.name, sessionId, {
              kind: file.kind,
              mimeType: file.mimeType,
              token,
            }),
          };
        });
        const inserted = chips.map((chip) => chip.token).join("");
        const nextText =
          sourceValue.slice(0, selectionStart) +
          inserted +
          sourceValue.slice(selectionEnd);
        const previousReferences = snapshotReferences(sourceSessionId ?? "");
        const nextReferences = [
          ...previousReferences.map((reference) =>
            createFileReference(reference.path, reference.name, sessionId!, reference),
          ),
          ...chips.map((chip) => chip.reference),
        ];
        writeComposerDraft(sessionId, {
          text: nextText,
          fileReferences: [
            ...previousReferences,
            ...chips.map((chip) => toDraftReference(chip.reference)),
          ],
        });
        const currentSessionId = useAppStore.getState().activeSessionId;
        if (currentSessionId === sessionId) {
          draft.applyEditorDraft(nextText, nextReferences, selectionStart + inserted.length);
        } else if (sourceDraftKey === HOME_DRAFT_KEY) {
          deleteComposerDraft(HOME_DRAFT_KEY);
        }
        showToast(
          t,
          files.length ? "chat.filesPasted" : "chat.largeTextPasted",
          files.length
            ? { count: result.files.length }
            : { name: result.files[0]?.name ?? "pasted-text" },
          "success",
        );
      } catch (error) {
        showErrorToast(t, error);
      } finally {
        setPasting(false);
      }
      return;
    }

    // Small text paste is kept plain so rich HTML never enters the draft.
    event.preventDefault();
    if (!text) return;
    void api.recordClipboardPaste(text).catch(() => undefined);
    if (!document.execCommand("insertText", false, text)) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      draft.commitEditorDom?.();
    }
  };

  const attachDroppedItems = async (items: ComposerDropItem[]) => {
    if (isInputBlocked || items.length === 0) return;
    const editor = draft.ref.current;
    const sourceValue = editor ? readEditorValue(editor) : draft.valueRef.current;
    const { start: selectionStart, end: selectionEnd } = editor
      ? editorSelectionRange(editor)
      : { start: sourceValue.length, end: sourceValue.length };
    const sourceSessionId = activeSessionId;
    const sourceDraftKey = draftKey;
    const previousReferences = snapshotReferences(sourceSessionId ?? "");
    const fileItems = items.filter((item) => !item.isDirectory);
    setPasting(true);
    try {
      let sessionId = sourceSessionId;
      if (fileItems.length && !sessionId) sessionId = (await materializeDraftSession()) ?? "";
      if (fileItems.length && !sessionId) throw new Error("session unavailable");

      const pasted = fileItems.length
        ? await api
            .pasteFiles(
              sessionId!,
              await Promise.all(
                fileItems.map(async ({ file }) => ({
                  name: file.name || undefined,
                  mimeType: file.type || undefined,
                  data: await file.arrayBuffer(),
                })),
              ),
            )
            .then((result) => result.files)
        : [];
      const chips = pasted.map((file) => {
        const token = nextChipToken();
        return {
          token,
          reference: createFileReference(file.path, file.name, sessionId ?? "", {
            kind: file.kind,
            mimeType: file.mimeType,
            token,
          }),
        };
      });
      let fileIndex = 0;
      const inserted = items
        .map((item) => {
          if (item.isDirectory) return item.path ? formatDroppedDirectoryPath(item.path) : "";
          const chip = chips[fileIndex];
          fileIndex += 1;
          return chip?.token ?? "";
        })
        .filter(Boolean)
        .join(" ");
      if (!inserted) return;

      const nextText =
        sourceValue.slice(0, selectionStart) +
        inserted +
        sourceValue.slice(selectionEnd);
      const ownerSessionId = sessionId ?? "";
      const nextReferences = [
        ...previousReferences.map((reference) =>
          createFileReference(reference.path, reference.name, ownerSessionId, reference),
        ),
        ...chips.map((chip) => chip.reference),
      ];
      const targetKey = sessionId || sourceDraftKey;
      writeComposerDraft(targetKey, {
        text: nextText,
        fileReferences: [
          ...previousReferences,
          ...chips.map((chip) => toDraftReference(chip.reference)),
        ],
      });
      const currentSessionId = useAppStore.getState().activeSessionId;
      if (currentSessionId === sessionId) {
        draft.applyEditorDraft(nextText, nextReferences, selectionStart + inserted.length);
      } else if (sourceDraftKey === HOME_DRAFT_KEY && sessionId) {
        deleteComposerDraft(HOME_DRAFT_KEY);
      }
      if (chips.length) showToast(t, "chat.filesAttached", { count: chips.length }, "success");
    } catch (error) {
      showErrorToast(t, error);
    } finally {
      setPasting(false);
    }
  };

  const onComposerDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDropTargetActive(true);
  };

  const onComposerDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setDropTargetActive(false);
  };

  const openDroppedFolderAsProject = async () => {
    const directories = droppedDirectories;
    setDroppedDirectories([]);
    try {
      for (const directory of directories) {
        if (directory.path) await useAppStore.getState().activateProject(directory.path);
      }
    } catch (error) {
      showErrorToast(t, error);
    }
  };

  const insertDroppedDirectoryPaths = () => {
    const directories = droppedDirectories;
    setDroppedDirectories([]);
    if (directories.length) void attachDroppedItems(directories);
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDropTargetActive(false);
    if (isInputBlocked) return;
    const items = composerDropItems(event.dataTransfer, api.getDroppedFilePath);
    const directories = items.filter((item) => item.isDirectory);
    const files = items.filter((item) => !item.isDirectory);
    // A folder drop needs an explicit choice: open as project or reference it.
    if (directories.length) setDroppedDirectories(directories);
    if (files.length) void attachDroppedItems(files);
  };

  return {
    pasting,
    dropTargetActive,
    setDropTargetActive,
    droppedDirectories,
    pickAndAttach,
    pasteClipboardFiles,
    attachDroppedItems,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    openDroppedFolderAsProject,
    insertDroppedDirectoryPaths,
    dismissDroppedDirectories: () => setDroppedDirectories([]),
  };
}

function toDraftReference(reference: ComposerFileReference): ComposerDraftSnapshot["fileReferences"][number] {
  return {
    path: reference.path,
    name: reference.name,
    kind: reference.kind,
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    ...(reference.token ? { token: reference.token } : {}),
  };
}

function showToast(
  t: TFunction,
  key: string,
  options: Record<string, unknown>,
  variant: "success" | "info",
): void {
  useAppStore.getState().showToast(t(key, options), { variant });
}

function showErrorToast(t: TFunction, error: unknown): void {
  useAppStore
    .getState()
    .showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
}
