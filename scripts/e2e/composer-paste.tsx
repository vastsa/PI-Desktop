import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import type { TFunction } from "i18next";
import { en } from "@pi-desktop/i18n";
import {
  ComposerInput,
  type ComposerInputProps,
} from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { useComposerAttachments } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerAttachments";
import {
  useComposerDraft,
  type ComposerDraftController,
} from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import {
  editorSelectionRange,
  readEditorValue,
  setEditorCaret,
} from "../../apps/desktop/src/features/chat/composer/editor";
import { api } from "../../apps/desktop/src/lib/api";
import {
  readComposerDraft,
  resetComposerDraftCache,
} from "../../apps/desktop/src/lib/composer-draft-cache";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var composerPasteProbe: () => Promise<unknown>;
}
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const sessions = [{ id: "paste-a" }, { id: "paste-b" }];
const noop = () => {};
let controller: ComposerDraftController;
let pastePending: Promise<unknown> | undefined;
function Fixture({ sessionId, t }: { sessionId: string; t: TFunction }) {
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: sessionId,
    workspacePath: "",
    sessions,
    composerPrefill: null,
    clearComposerPrefill: noop,
    t,
    invalidatePromptEnhancement: noop,
    inputBlocked: false,
  });
  controller = draft;
  const attachments = useComposerAttachments({
    inputBlocked: false,
    activeSessionId: sessionId,
    draftKey: draft.draftKey,
    largePasteThreshold: 600,
    t,
    draft,
  });
  return (
    <ComposerInput
      inputRef={draft.ref}
      value={draft.value}
      placeholderText=""
      placeholderKey="fixture"
      inputBlocked={attachments.pasting}
      pasting={attachments.pasting}
      enterToSend={false}
      runActive={false}
      composerAc={
        { open: false, close: noop } as ComposerInputProps["composerAc"]
      }
      onPaste={(event) => {
        pastePending = Promise.resolve(attachments.pasteClipboardFiles(event));
      }}
      onAcceptCompletion={noop}
      onSubmit={noop}
      onInsertNewline={draft.insertNewlineInEditor}
      onInput={draft.handleInput}
      onCompositionStart={noop}
      onCompositionEnd={noop}
      onFocus={noop}
      onBlur={noop}
    />
  );
}

globalThis.composerPasteProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  let key = 0;
  const render = (sessionId = "paste-a") => {
    useAppStore.setState({ activeSessionId: sessionId });
    flushSync(() =>
      root.render(<Fixture key={key} sessionId={sessionId} t={i18n.t} />),
    );
    assert(
      errors.length === 0,
      `React failed: ${errors.map(String).join("; ")}`,
    );
  };
  const reset = async (
    source = "prefix REPLACE suffix",
    start = 7,
    end = 14,
  ) => {
    key++;
    resetComposerDraftCache();
    render();
    const editor = controller.ref.current!;
    flushSync(() => controller.applyEditorDraft(source, [], start));
    await new Promise(requestAnimationFrame);
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, start);
    range.setEnd(editor.firstChild!, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return editor;
  };
  const dispatchPaste = async (
    editor: HTMLDivElement,
    text: string,
    files: File[],
  ) => {
    const data = new DataTransfer();
    if (text) {
      data.setData("text/plain", text);
      data.setData("text/html", `<b>${text}</b>`);
    }
    for (const file of files) data.items.add(file);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => editor.dispatchEvent(event));
    await pastePending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(event.defaultPrevented, "paste was not handled");
    assert(
      errors.length === 0,
      `React failed: ${errors.map(String).join("; ")}`,
    );
    return editor;
  };
  const paste = async (text: string, files: File[], empty = false) =>
    dispatchPaste(await (empty ? reset("", 0, 0) : reset()), text, files);
  const select = (editor: HTMLElement, start: number, end: number) => {
    setEditorCaret(editor, start);
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0).cloneRange();
    setEditorCaret(editor, end);
    const last = selection.getRangeAt(0);
    range.setEnd(last.startContainer, last.startOffset);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  try {
    const nativeFiles = Array.from(
      (document.getElementById("native-files") as HTMLInputElement).files!,
    );
    assert(
      nativeFiles.length === 2 &&
        nativeFiles.every((file) => api.getDroppedFilePath(file)),
      "native File paths unavailable through real preload",
    );
    const image = new File([await nativeFiles[0].arrayBuffer()], "image.png", {
      type: "image/png",
    });
    assert(
      !api.getDroppedFilePath(image),
      "synthetic clipboard image unexpectedly has a native path",
    );
    const text = "Word paragraph 中文\nsecond line";
    let editor = await paste(text, [image]);
    assert(
      readEditorValue(editor) === `prefix ${text} suffix`,
      `Word text mismatch: ${JSON.stringify(readEditorValue(editor))}; white-space=${getComputedStyle(editor).whiteSpace}; contenteditable=${editor.contentEditable}; DOM=${editor.innerHTML}`,
    );
    assert(
      controller.fileReferences.length === 0,
      "Word text created an image reference",
    );
    assert(
      editorSelectionRange(editor).start === 7 + text.length,
      `text paste caret moved: ${editorSelectionRange(editor).start} expected ${7 + text.length}; DOM=${editor.innerHTML}`,
    );
    assert(!editor.querySelector("b"), "rich HTML entered the draft");

    const multilineCases = [
      "first\r\n\r\nlast\r\n",
      '<img src=x onerror="throw 1">\n<&> "quotes" \'single\'',
      "  leading \ntrailing  ",
      "line\n\n",
      // A Word selection can start above the copied text, so the pasted string
      // may begin with one or more line breaks.
      "\nsecond",
      "\n\nline",
      "\nA\nB\n",
    ];
    for (const content of multilineCases) {
      editor = await paste(content, [image]);
      const normalized = content.replace(/\r\n?/g, "\n");
      assert(
        readEditorValue(editor) === `prefix ${normalized} suffix`,
        `multiline text changed: ${JSON.stringify(readEditorValue(editor))}`,
      );
      assert(
        editorSelectionRange(editor).start === 7 + normalized.length,
        "multiline caret moved",
      );
      assert(
        !editor.querySelector("img,script,b"),
        "plain text interpreted as HTML",
      );
      assert(document.execCommand("undo"), "native undo unavailable");
      await new Promise(requestAnimationFrame);
      assert(
        readEditorValue(editor) === "prefix REPLACE suffix",
        "undo did not restore the replaced selection",
      );
      assert(document.execCommand("redo"), "native redo unavailable");
      await new Promise(requestAnimationFrame);
      assert(
        readEditorValue(editor) === `prefix ${normalized} suffix`,
        "redo lost multiline text",
      );
    }
    editor = await paste("line\n\n", [image], true);
    assert(
      readEditorValue(editor) === "line\n\n",
      `trailing newlines lost: ${JSON.stringify(readEditorValue(editor))}`,
    );
    assert(
      editorSelectionRange(editor).start === 6,
      "empty editor paste caret moved",
    );

    // Forced insertHTML failure: the raw-DOM fallback must still store the
    // editor's LF draft model instead of the clipboard's CRLF bytes.
    const realExecCommand = document.execCommand.bind(document);
    document.execCommand = ((
      commandId: string,
      ...rest: [boolean?, string?]
    ) =>
      commandId === "insertHTML"
        ? false
        : realExecCommand(commandId, ...rest)) as typeof document.execCommand;
    try {
      editor = await paste("fallback\r\ntext", [image], true);
      assert(
        readEditorValue(editor) === "fallback\ntext",
        `fallback kept clipboard line endings: ${JSON.stringify(readEditorValue(editor))}`,
      );
    } finally {
      document.execCommand = realExecCommand;
    }

    const beforeReplace = "one\nTWO\nthree";
    editor = await paste(beforeReplace, [image], true);
    assert(
      editor.querySelector("br"),
      "multiline fixture is missing a real BR",
    );
    select(editor, 2, 8);
    await dispatchPaste(editor, "A\nB", [image]);
    assert(
      readEditorValue(editor) === "onA\nBthree",
      "replacement across BR changed surrounding text",
    );
    assert(
      editorSelectionRange(editor).start === 5,
      "replacement across BR moved caret",
    );
    assert(document.execCommand("undo"), "cross-BR undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(editor) === beforeReplace,
      "cross-BR undo changed text",
    );
    assert(document.execCommand("redo"), "cross-BR redo unavailable");
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(editor) === "onA\nBthree",
      "cross-BR redo changed text",
    );

    const longText = "字".repeat(601);
    editor = await paste(longText, [image]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].mimeType === "text/plain",
      "large mixed paste did not use the text threshold",
    );
    assert(
      readEditorValue(editor) ===
        `prefix ${controller.fileReferences[0].token} suffix`,
      "large text chip lost the selection boundary",
    );

    await paste("", [image]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].kind === "image",
      "image-only paste changed",
    );
    await paste("native-image.png", [nativeFiles[0]]);
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].kind === "image",
      "native image file was mistaken for text",
    );
    await paste("file names", nativeFiles);
    assert(
      controller.fileReferences.length === 2,
      "mixed native files were lost",
    );
    assert(
      controller.fileReferences[1].mimeType === "text/plain",
      "native text file became inline text",
    );

    const saved = readComposerDraft("paste-a");
    assert(
      saved?.fileReferences.length === 2,
      "file references did not persist in the owning draft",
    );
    render("paste-b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(controller.value === "", "attachments leaked into another session");
    render("paste-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
      controller.fileReferences.length === 2,
      "session switch lost attachments",
    );
    const reference = controller.fileReferences[0];
    flushSync(() =>
      controller.applyEditorDraft(
        `left${reference.token}right`,
        [reference],
        4,
      ),
    );
    await new Promise(requestAnimationFrame);
    editor = controller.ref.current!;
    select(editor, 3, 6);
    await dispatchPaste(editor, "X\nY", [image]);
    assert(
      readEditorValue(editor) === "lefX\nYight",
      "replacement across attachment chip changed surrounding text",
    );
    assert(
      controller.fileReferences.length === 0,
      "replaced attachment stayed in draft metadata",
    );
    return {
      ok: true,
      mixedShortText: true,
      multilineAndUndoRedo: true,
      crossBreakAndChipSelection: true,
      mixedLongText: true,
      imageOnly: true,
      nativeImageFile: true,
      nativeMultipleFiles: true,
      selectionAndSessionDrafts: true,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    resetComposerDraftCache();
  }
};
