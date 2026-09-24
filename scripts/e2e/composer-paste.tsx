import { serializeInlineComposerFileReferences } from "@pi-desktop/shared";
import { useComposerSubmit } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerSubmit";
import { verifyComposerSubmission } from "./composer-submission";
import { ComposerImageAttachments } from "../../apps/desktop/src/features/chat/composer/ComposerImageAttachments";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { isBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";
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
  createFileReference,
  editorSelectionRange,
  readEditorValue,
  setEditorCaret,
} from "../../apps/desktop/src/features/chat/composer/editor";
import { api } from "../../apps/desktop/src/lib/api";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import {
  readComposerDraft,
  resetComposerDraftCache,
} from "../../apps/desktop/src/lib/composer-draft-cache";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var composerPreviewPointer: (input: { type: "mousePressed" | "mouseMoved" | "mouseReleased"; x: number; y: number }) => Promise<void>;
  var composerPreviewPressKey: (key: string) => Promise<void>;
  var composerPreviewCapture: (() => Promise<void>) | undefined;
  var composerPasteProbe: () => Promise<unknown>;
}
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const sessions = [{ id: "paste-a" }, { id: "paste-b" }];
const noop = () => {};
let controller: ComposerDraftController;
let pastePending: Promise<unknown> | undefined;
let submitted = 0;
let rejectedContent = "";
let acceptSubmission = false;
let rejectSubmission: () => Promise<void>;
function Fixture({ sessionId, t, workspacePath }: { sessionId: string; t: TFunction; workspacePath: string }) {
  const composerPrefill = useAppStore((state) => state.composerPrefill);
  const clearComposerPrefill = useAppStore((state) => state.clearComposerPrefill);
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: sessionId,
    workspacePath,
    sessions,
    composerPrefill,
    clearComposerPrefill,
    t,
    invalidatePromptEnhancement: noop,
    inputBlocked: false,
  });
  controller = draft;
  rejectSubmission = useComposerSubmit({
    value: draft.value, draftKey: draft.draftKey, activeSessionId: sessionId,
    thinkingLevel: "off", modelReady: true, sendBlocked: false, pasting: false,
    activeFileReferences: draft.activeFileReferences, t, draft,
    excerpts: draft.excerpts,
    sendPrompt: async (content) => { rejectedContent = content; return acceptSubmission; },
    steerPrompt: async (content) => { rejectedContent = content; return acceptSubmission; },
    showToast: noop,
  }).submit;
  const attachments = useComposerAttachments({
    inputBlocked: false,
    activeSessionId: sessionId,
    draftKey: draft.draftKey,
    largePasteThreshold: 600,
    t,
    draft,
  });
  return (
    <div className="composer-stack">
      <ComposerImageAttachments controller={draft.imagePreview} onRemove={draft.removeImage} disabled={attachments.pasting} />
      <div className="composer-shell">
      <ComposerInput
        imagePreview={draft.imagePreview}
        excerpts={draft.excerpts}
        onRemoveExcerpt={draft.removeExcerpt}
        inputRef={draft.ref}
        value={draft.value}
        placeholderText=""
        placeholderKey="fixture"
        inputBlocked={attachments.pasting}
        pasting={attachments.pasting}
        enterToSend={true}
        runActive={false}
        composerAc={
          { open: false, close: noop } as ComposerInputProps["composerAc"]
        }
        onPaste={(event) => {
          pastePending = Promise.resolve(attachments.pasteClipboardFiles(event));
        }}
        onAcceptCompletion={noop}
        onSubmit={() => { submitted++; }}
        onInsertNewline={draft.insertNewlineInEditor}
        onInput={draft.handleInput}
        onCompositionStart={noop}
        onCompositionEnd={noop}
        onFocus={noop}
        onBlur={noop}
      />
      </div>
    </div>
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
  const render = (sessionId = "paste-a", workspacePath = "") => {
    useAppStore.setState({ activeSessionId: sessionId });
    flushSync(() =>
      root.render(<I18nextProvider i18n={i18n}><Fixture key={key} sessionId={sessionId} t={i18n.t} workspacePath={workspacePath} /></I18nextProvider>),
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
    useAppStore.setState({ workPanelOpen: false, workspace: null });
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
    // Settings replaces ChatSurface, then remounts the composer in the same
    // workspace. Exercise the real draft hook and DOM across that lifecycle.
    render("paste-a", "/project-a");
    const referenceDraft = "Check \uE001 and \uE002";
    const references = [
      createFileReference("src/main.ts", "main.ts", "paste-a", { token: "\uE001" }),
      createFileReference("/scratch/paste-a/notes.txt", "notes.txt", "paste-a", { token: "\uE002" }),
    ];
    flushSync(() => controller.applyEditorDraft(referenceDraft, references, referenceDraft.length));
    await new Promise(requestAnimationFrame);
    flushSync(() => root.render(null));
    render("paste-a", "/project-a");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === referenceDraft,
      "Settings round-trip lost a workspace file reference from the draft");
    assert(controller.fileReferences.length === 2 && controller.ref.current!.textContent!.includes("main.ts"),
      "Settings round-trip must restore both workspace and scratch chips");
    flushSync(() => root.render(null));
    render("paste-a", "/project-b");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === "Check  and \uE002",
      "changing workspace while the composer is unmounted must remove the previous workspace's chip");
    assert(controller.fileReferences.length === 1 && controller.fileReferences[0].path === references[1].path,
      "changing workspace must preserve scratch references");

    // Transcript excerpts append to the active draft without replacing its
    // text or attachments, and leave the caret ready for editing.
    await reset("Keep this", 9, 9);
    const retainedReference = createFileReference(
      "/scratch/paste-a/retained.txt",
      "retained.txt",
      "paste-a",
      { kind: "file" },
    );
    flushSync(() => controller.setFileReferences([retainedReference]));
    flushSync(() =>
      useAppStore.getState().appendComposerText(
        "paste-a",
        "> selected\n>\n> excerpt",
      ),
    );
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const appended = "Keep this\n\n> selected\n>\n> excerpt";
    assert(
      readEditorValue(controller.ref.current!) === appended,
      "transcript excerpt replaced or malformed the existing draft",
    );
    assert(
      controller.fileReferences.length === 1 &&
        controller.fileReferences[0].path === retainedReference.path,
      "transcript excerpt removed an existing file reference",
    );
    assert(
      editorSelectionRange(controller.ref.current!).start === appended.length,
      "transcript excerpt did not focus the composer caret at the end",
    );
    render("paste-b");
    await new Promise(requestAnimationFrame);
    flushSync(() => controller.applyEditorDraft("Session B", [], 9));
    flushSync(() =>
      useAppStore.getState().appendComposerText("paste-a", "> stale excerpt"),
    );
    await new Promise(requestAnimationFrame);
    assert(
      readEditorValue(controller.ref.current!) === "Session B" &&
        useAppStore.getState().composerPrefill === null,
      "an excerpt queued for another session changed the active draft",
    );
    render("paste-a");
    await new Promise(requestAnimationFrame);
    assert(
      !readEditorValue(controller.ref.current!).includes("stale excerpt"),
      "a stale excerpt appeared after returning to its original session",
    );

    // Selected transcript text is a compact draft attachment, not editable
    // prompt text. Its contents follow the draft through a session switch and
    // return after a rejected send.
    await reset("Keep this", 9, 9);
    assert(useAppStore.getState().addComposerExcerpt("paste-a", "first line\nsecond line"),
      "could not attach selected text");
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === "Keep this",
      "selected text was inserted into the editable prompt");
    assert(document.querySelector(".composer-excerpts-badge")?.textContent?.includes("1 annotation"),
      "the selected-text count badge was not shown");
    flushSync(() => (document.querySelector(".composer-excerpts-badge") as HTMLButtonElement).click());
    assert(document.querySelector(".composer-excerpt blockquote")?.textContent === "first line\nsecond line",
      "the count badge did not reveal the selected source");
    assert(useAppStore.getState().addComposerExcerpt("paste-a", "another excerpt"),
      "could not attach a second selection");
    await new Promise(requestAnimationFrame);
    assert(document.querySelector(".composer-excerpts-badge")?.textContent?.includes("2 annotations"),
      "multiple selections did not share a count badge");
    render("paste-b");
    await new Promise(requestAnimationFrame);
    assert(!document.querySelector(".composer-excerpts-badge"),
      "session B showed session A's selected text");
    assert(!useAppStore.getState().addComposerExcerpt("paste-a", "stale selection"),
      "a selection was attached after leaving its session");
    render("paste-a");
    await new Promise(requestAnimationFrame);
    assert(controller.excerpts.length === 2,
      "selected text was lost across a session switch");
    await rejectSubmission();
    await new Promise(requestAnimationFrame);
    assert(rejectedContent.includes("Keep this\n\nSelected conversation excerpts:") &&
      rejectedContent.includes("> first line\n> second line") &&
      rejectedContent.includes("> another excerpt"),
      "the submitted prompt did not include the attached selections");
    assert(controller.excerpts.length === 2 && readEditorValue(controller.ref.current!) === "Keep this",
      "a rejected send did not restore the selected-text attachments");
    if (!document.querySelector(".composer-excerpt-remove")) {
      flushSync(() => (document.querySelector(".composer-excerpts-badge") as HTMLButtonElement).click());
    }
    flushSync(() => (document.querySelector(".composer-excerpt-remove") as HTMLButtonElement).click());
    assert(controller.excerpts.length === 1,
      "removing an attached selection did not update the draft");
    assert(document.querySelector(".composer-excerpts-badge")?.textContent?.includes("1 annotation"),
      "removing an excerpt did not update the count badge");
    acceptSubmission = true;
    await rejectSubmission();
    await new Promise(requestAnimationFrame);
    assert(controller.excerpts.length === 0 && !document.querySelector(".composer-excerpts-badge"),
      "an accepted send did not clear the attached selection");
    acceptSubmission = false;

    // Keep the source attachment snapshot when a paste finishes in another session.
    await reset("keep \uE010 ", 7, 7);
    const originalReference = createFileReference("/scratch/paste-a/original.txt", "original.txt", "paste-a", { token: "\uE010", kind: "file" });
    flushSync(() => controller.applyEditorDraft("keep \uE010 ", [originalReference], 7));
    await new Promise(requestAnimationFrame);
    const originalPasteFiles = api.pasteFiles;
    let releasePaste!: () => void;
    const responseGate = new Promise<void>((resolve) => { releasePaste = resolve; });
    let started = false;
    api.pasteFiles = async () => {
      started = true;
      await responseGate;
      return { files: [{ path: "/scratch/paste-a/new.txt", name: "new.txt", kind: "file", mimeType: "text/plain" }] };
    };
    try {
      const pendingPaste = dispatchPaste(controller.ref.current!, "", [new File(["new"], "new.txt", {type: "text/plain"})]);
      while (!started) await new Promise(requestAnimationFrame);
      render("paste-b");
      await new Promise(requestAnimationFrame);
      releasePaste();
      await pendingPaste;
      assert(controller.value === "", "pending paste changed the destination draft");
      render("paste-a");
      await new Promise(requestAnimationFrame);
      const names = controller.fileReferences.map((r) => r.name);
      assert(names.includes("original.txt") && names.includes("new.txt"),
        "PENDING_PASTE_SESSION_SWITCH lost original attachment: " + JSON.stringify({ names, text: readEditorValue(controller.ref.current!), visible: controller.ref.current!.textContent }));
    } finally {
      releasePaste();
      api.pasteFiles = originalPasteFiles;
    }
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

    // Preview the persisted long-text attachment through the public work-panel
    // entry point, with no project open (the temporary-task user path).
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    const previewRoot = createRoot(previewHost);
    try {
      flushSync(() => previewRoot.render(
        <I18nextProvider i18n={i18n}><FilesTab /></I18nextProvider>,
      ));
      assert(previewHost.textContent?.includes(i18n.t("panel.files.noWorkspace")),
        "file browsing without a project should show the empty state");
      flushSync(() => useAppStore.getState().openFileInWorkPanel(
        controller.fileReferences[0].path, "text/plain",
      ));
      const deadline = performance.now() + 3000;
      while (!previewHost.querySelector(".file-viewer-code") && performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
      }
      assert(previewHost.querySelector(".file-viewer-code")?.textContent === longText,
        "temporary-task attachment did not display its saved text in the file preview");
      const back = previewHost.querySelector<HTMLButtonElement>(
        `[aria-label="${i18n.t("panel.files.back")}"]`,
      );
      assert(back, "file preview must provide back navigation");
      flushSync(() => back!.click());
      assert(previewHost.textContent?.includes(i18n.t("panel.files.noWorkspace")),
        "back from a temporary attachment should restore the no-project empty state");
    } finally {
      flushSync(() => previewRoot.unmount());
      previewHost.remove();
    }

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
    assert(!controller.ref.current!.querySelector("img"), "image thumbnails must be outside the text editor");
    assert(document.querySelector(".composer-image-attachments"), "image thumbnails must have a separate row above the input");
    const tray = document.querySelector<HTMLElement>(".composer-image-attachments")!;
    const shell = document.querySelector<HTMLElement>(".composer-shell")!;
    assert(!shell.contains(tray) && tray.getBoundingClientRect().bottom <= shell.getBoundingClientRect().top,
      "attachment row must sit above and outside the input shell");
    assert(readEditorValue(controller.ref.current!) === "prefix  suffix", "image token leaked into visible text");
    // #117: enter through the real attachment, read through sandboxed image IPC,
    // and keep the draft, caret, and work-panel state independent of inspection.
    editor = controller.ref.current!;
    const beforePreview = readEditorValue(editor);
    const imageReference = controller.fileReferences[0];
    const chip = document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!;
    assert(chip.tagName === "BUTTON" && chip.tabIndex === 0,
      "image attachment must be keyboard accessible");
    const dialog = () => document.querySelector<HTMLDialogElement>("dialog.composer-image-preview[open]");
    const until = async (condition: () => unknown, message: string) => {
      const deadline = performance.now() + 5000;
      while (!condition() && performance.now() < deadline) await new Promise(requestAnimationFrame);
      assert(condition(), `${message}; errors=${errors.map(String)}; dialog=${dialog()?.textContent}; image=${dialog()?.querySelector("img")?.outerHTML}`);
    };
    let previewCheck = 0;
    const previewReady = async () => {
      previewCheck++;
      await until(() => {
        const img = dialog()?.querySelector<HTMLImageElement>(".composer-image-preview-viewport img");
        return img?.complete && img.naturalWidth > 0 && img.style.width !== "";
      }, `image preview did not load at check ${previewCheck}`);
      await new Promise(requestAnimationFrame);
      return dialog()!.querySelector<HTMLImageElement>(".composer-image-preview-viewport img")!;
    };
    const button = (label: string) => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.getAttribute("aria-label") === label || element.textContent === label)!;
    const close = () => flushSync(() => button(i18n.t("common.close")).click());
    await until(() => chip.querySelector<HTMLImageElement>("img")?.naturalWidth === 1, "attachment thumbnail missing");
    editor.focus();
    setEditorCaret(editor, 7);
    flushSync(() => chip.click());
    assert(dialog(), "image attachment must open an overlay instead of the work panel");
    assert(dialog()!.matches(":modal"), "preview must use native modal focus containment");
    assert(isBlockingOverlayActive(), "preview must suppress native plugin surfaces");
    const preview = await previewReady();
    editor.focus();
    assert(dialog()!.contains(document.activeElement), "modal allowed background input focus");
    button(i18n.t("chat.imagePreview.fit")).focus();
    await globalThis.composerPreviewPressKey("Tab");
    assert(dialog()!.contains(document.activeElement), "Tab escaped the preview");
    assert(preview.naturalWidth === 1 && preview.getBoundingClientRect().width === 1,
      "small image must not be stretched to fill the window");
    assert(!useAppStore.getState().workPanelOpen, "preview opened the work panel");
    const viewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    assert(Math.abs((preview.getBoundingClientRect().left + preview.getBoundingClientRect().right) / 2 -
      (viewport.getBoundingClientRect().left + viewport.getBoundingClientRect().right) / 2) <= 1,
      "preview must be horizontally centered");
    assert(readEditorValue(editor) === beforePreview && controller.fileReferences.length === 1,
      "preview changed the unsent draft");
    flushSync(() => button(i18n.t("menu.zoomIn")).click());
    assert(dialog()!.querySelector("output")?.textContent === "125%", `zoom in failed: ${dialog()!.querySelector("output")?.textContent}, disabled=${button(i18n.t("menu.zoomIn")).disabled}, imageStyle=${preview.getAttribute("style")}`);
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    assert(dialog()!.querySelector("output")?.textContent === "100%", "fit did not reset zoom");
    const download = dialog()!.querySelector<HTMLAnchorElement>("a[download]")!;
    assert(download.download === imageReference.name && download.href === preview.src,
      "download did not point to the original image with its filename");
    close();
    assert(!dialog() && !isBlockingOverlayActive(), "closing left the modal or native-view blocker active");
    assert(document.activeElement === editor && editorSelectionRange(editor).start === 7,
      "closing did not restore the draft caret");
    for (const key of ["Enter", " "]) {
      chip.focus();
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      flushSync(() => chip.dispatchEvent(event));
      assert(event.defaultPrevented, "preview key inserted text or sent the draft");
      await previewReady();
      assert(readEditorValue(editor) === beforePreview && submitted === 0,
        "preview key altered or sent the draft");
      await globalThis.composerPreviewPressKey("Escape");
      await until(() => !dialog(), "native Escape did not dismiss the preview");
      assert(!dialog() && document.activeElement === chip, "cancel did not close and restore attachment focus");
    }
    // The isolated host supplies real images within the allowed scratch directory.
    const wide = createFileReference(imageReference.path.replace(/[^/\\]+$/, "wide-fixture.png"), "wide.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: "\ueffe",
    });
    flushSync(() => controller.applyEditorDraft(`${beforePreview}${wide.token}`, [imageReference, wide], 7));
    flushSync(() => document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!.click());
    await previewReady();
    assert(button(i18n.t("chat.imagePreview.previous")).disabled, "first image should disable previous");
    flushSync(() => button(i18n.t("chat.imagePreview.next")).click());
    const widePreview = await previewReady();
    const rect = widePreview.getBoundingClientRect();
    assert(widePreview.naturalWidth === 1200 && Math.abs(rect.width / rect.height - 2) < 0.02,
      "wide preview lost its original aspect ratio");
    assert(rect.width <= dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!.clientWidth + 1 && rect.height <= dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!.clientHeight + 1,
      "large image did not fit the preview viewport");
    assert(button(i18n.t("chat.imagePreview.next")).disabled, "last image should disable next");
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX + 80, y: startY + 40 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX + 80, y: startY + 40 });
    await new Promise(requestAnimationFrame);
    assert(dialog() && Math.abs(widePreview.getBoundingClientRect().left - rect.left - 80) <= 1 &&
      Math.abs(widePreview.getBoundingClientRect().top - rect.top - 40) <= 1,
      "dragging the image must move it without dismissing the preview");
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    assert(Math.abs(widePreview.getBoundingClientRect().left - rect.left) <= 1,
      "fit must recenter a dragged image");
    const panViewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    flushSync(() => panViewport.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 20, bubbles: true, cancelable: true })));
    assert(Math.abs(widePreview.getBoundingClientRect().left - rect.left + 30) <= 1,
      "ordinary scrolling must pan the image");
    flushSync(() => button(i18n.t("chat.imagePreview.fit")).click());
    let capturedPointer = -1;
    widePreview.addEventListener("pointerdown", (event) => { capturedPointer = event.pointerId; }, { once: true });
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    assert(capturedPointer !== -1 && widePreview.hasPointerCapture(capturedPointer), "image drag did not capture its pointer");
    flushSync(() => widePreview.dispatchEvent(new PointerEvent("pointercancel", { pointerId: capturedPointer, bubbles: true })));
    assert(!widePreview.hasPointerCapture(capturedPointer) && !widePreview.hasAttribute("data-dragging"),
      "cancelling must release capture and clear the dragging cursor");
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX + 60, y: startY + 20 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX + 60, y: startY + 20 });
    await new Promise(requestAnimationFrame);
    assert(dialog() && Math.abs(widePreview.getBoundingClientRect().left - rect.left) <= 1,
      "cancelled pointer kept moving or dismissed the image");


    flushSync(() => button(i18n.t("menu.zoomIn")).click());
    const zoomedViewport = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    const zoomedRect = widePreview.getBoundingClientRect();
    assert(Math.abs((zoomedRect.left + zoomedRect.right) / 2 -
      (zoomedViewport.getBoundingClientRect().left + zoomedViewport.getBoundingClientRect().right) / 2) <= 1,
      "zoom must preserve the image center");
    await globalThis.composerPreviewPointer({ type: "mousePressed", x: startX, y: startY });
    await globalThis.composerPreviewPointer({ type: "mouseMoved", x: startX - 100, y: startY - 50 });
    await globalThis.composerPreviewPointer({ type: "mouseReleased", x: startX - 100, y: startY - 50 });
    await new Promise(requestAnimationFrame);
    assert(Math.abs(widePreview.getBoundingClientRect().left - zoomedRect.left + 100) <= 1 && dialog(),
      "zoomed image must support dragging");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await previewReady();
    assert(dialog()!.querySelector("output")?.textContent === "100%", "gallery switch retained another image's zoom");
    flushSync(() => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const returnedPreview = await previewReady();
    assert(Math.abs(returnedPreview.getBoundingClientRect().left - rect.left) <= 1,
      "switching images must reset the pan position");
    const backdrop = dialog()!.querySelector<HTMLElement>(".composer-image-preview-viewport")!;
    flushSync(() => backdrop.click());
    assert(!dialog(), "blank-area click did not close preview");
    if (globalThis.composerPreviewCapture) await globalThis.composerPreviewCapture();
    editor.focus();
    select(editor, 0, readEditorValue(editor).length);
    assert(document.execCommand("insertText", false, "new prompt"), "text replacement failed");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 2 && document.querySelectorAll(".composer-image-attachment").length === 2,
      "editing all text removed independent image attachments");
    assert(controller.draftSnapshot("new prompt").fileReferences.length === 2,
      "submission snapshot lost detached images");
    assert(document.execCommand("undo"), "image draft text undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(editor) === beforePreview && controller.fileReferences.length === 2,
      "text undo changed image attachments");

    // Cancelled image reads must never overwrite a later draft's image.
    const realRead = api.fsReadImageDataUrl;
    let rejectRead: ((reason: Error) => void) | undefined;
    const delayed = createFileReference(imageReference.path, "delayed.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    api.fsReadImageDataUrl = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    try {
      flushSync(() => controller.applyEditorDraft(beforePreview, [delayed], 7));
      flushSync(() => document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!.click());
      assert(rejectRead && dialog(), "deferred image read was not started");
      api.fsReadImageDataUrl = realRead;
      flushSync(() => controller.applyEditorDraft(beforePreview, [imageReference], 7));
      assert(!dialog(), "removed preview attachment left the dialog open");
      flushSync(() => document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!.click());
      await previewReady();
      rejectRead!(new Error("late fixture read failure"));
      await new Promise(requestAnimationFrame);
      assert(dialog()?.querySelector("img"), "stale failure replaced the newer preview");
    } finally { api.fsReadImageDataUrl = realRead; }
    render("paste-b");
    await new Promise(requestAnimationFrame);
    assert(!dialog() && !isBlockingOverlayActive(), "session switch retained the old preview");
    render("paste-a");
    await new Promise(requestAnimationFrame);
    editor = controller.ref.current!;
    const currentChip = document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!;
    assert(currentChip, "returning to the session did not restore its image chip");
    useAppStore.setState({ activeSessionId: "paste-b" });
    flushSync(() => currentChip.click());
    assert(!dialog(), "old chip opened in another session");
    useAppStore.setState({ activeSessionId: "paste-a" });
    const remove = currentChip.parentElement!.querySelector<HTMLButtonElement>(".composer-image-attachment-remove")!;
    flushSync(() => {
      remove.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      remove.click();
    });
    assert(!dialog() && submitted === 0, "remove opened the preview or submitted the prompt");
    assert(controller.fileReferences.length === 0 && readEditorValue(editor) === "prefix  suffix",
      "remove did not preserve the surrounding draft");

    // Failed images remain attached, show a retry action, and never blank the draft.
    const missing = createFileReference(`${imageReference.path}.missing.png`, "missing.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    flushSync(() => controller.applyEditorDraft(beforePreview, [missing], 7));
    flushSync(() => document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!.click());
    await until(() => dialog()?.textContent?.includes(i18n.t("chat.imagePreview.error")), "missing image did not show an error");
    assert(readEditorValue(editor) === beforePreview && controller.fileReferences.length === 1,
      "failed preview lost the draft");
    api.fsReadImageDataUrl = () => realRead(imageReference.path, imageReference.mimeType);
    try {
      flushSync(() => button(i18n.t("chat.imagePreview.retry")).click());
      await previewReady();
    } finally { api.fsReadImageDataUrl = realRead; }
    close();
    const corrupt = createFileReference(imageReference.path.replace(/[^/\\]+$/, "corrupt-fixture.png"), "corrupt.png", "paste-a", {
      kind: "image", mimeType: "image/png", token: imageReference.token,
    });
    flushSync(() => controller.applyEditorDraft(beforePreview, [corrupt], 7));
    flushSync(() => document.querySelector<HTMLButtonElement>(".composer-image-attachment-open")!.click());
    await until(() => dialog()?.textContent?.includes(i18n.t("chat.imagePreview.error")), "undecodable image did not show retry");
    assert(readEditorValue(editor) === beforePreview, "decode failure changed the draft");
    close();

    // An image-only draft remains sendable and survives session switching.
    editor = await paste("", [image], true);
    assert(readEditorValue(editor) === "" && controller.draftSnapshot("").fileReferences.length === 1,
      "image-only draft lost its sendable attachment");
    const attachedId = controller.fileReferences[0].path;
    flushSync(() => controller.restoreDraftForKey("paste-a", { text: "older draft", fileReferences: [] }));
    assert(readEditorValue(editor) === "" && controller.fileReferences[0]?.path === attachedId,
      "restoring an old draft overwrote a newer image-only draft");
    render("paste-b");
    flushSync(() => controller.restoreDraftForKey("paste-a", { text: "older draft", fileReferences: [] }));
    render("paste-a");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences[0]?.path === attachedId && document.querySelector(".composer-image-attachment"),
      "image-only draft did not survive session switching");

    await paste("file names", nativeFiles);
    assert(
      controller.fileReferences.length === 2,
      "mixed native files were lost",
    );
    assert(
      controller.fileReferences[1].mimeType === "text/plain",
      "native text file became inline text",
    );

    const mixedDraft = controller.value;
    const mixedReferences = controller.fileReferences;
    flushSync(() => controller.ref.current!.querySelector<HTMLElement>('[data-action="expand-text-reference"]')!.click());
    const textDeadline = performance.now() + 5000;
    while (controller.fileReferences.length !== 1 && performance.now() < textDeadline) {
      await new Promise(requestAnimationFrame);
    }
    assert(controller.value.includes("native file bytes") && controller.fileReferences[0]?.kind === "image",
      "text chip no longer expands while preserving the image attachment");
    flushSync(() => controller.applyEditorDraft(mixedDraft, mixedReferences, mixedDraft.length));
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
    const reference = createFileReference("/fixture/file.bin", "file.bin", "paste-a", { kind: "file", token: "\ueffd" });
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
    // No store subscription forces a render between clearing and rejection.
    const retryImage = createFileReference(imageReference.path, "retry.png", "paste-a", { kind: "image", mimeType: "image/png" });
    flushSync(() => controller.applyEditorDraft("retry draft", [retryImage], 11));
    await new Promise(requestAnimationFrame);
    await rejectSubmission();
    await new Promise(requestAnimationFrame);
    assert(readEditorValue(controller.ref.current!) === "retry draft" && controller.fileReferences[0]?.path === imageReference.path,
      "fast rejection before React commits must restore the text and attachments");
    // Native undo must restore reference metadata as well as the visible chip.
    await reset("inspect \uE050 please", 8, 9);
    const undoReference = createFileReference("src/main.ts", "main.ts", "paste-a", { token: "\uE050" });
    flushSync(() => controller.applyEditorDraft("inspect \uE050 please", [undoReference], 9));
    await new Promise(requestAnimationFrame);
    const undoEditor = controller.ref.current!;
    undoEditor.focus();
    select(undoEditor, 8, 9);
    assert(document.execCommand("delete"), "native chip deletion unavailable");
    await new Promise(requestAnimationFrame);
    assert(document.execCommand("undo"), "native chip undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.some(r => r.path === "src/main.ts"), "Undo restored the chip without its file reference metadata");
    assert(serializeInlineComposerFileReferences(readEditorValue(undoEditor), controller.activeFileReferences) === "inspect @src/main.ts please",
      "undo must restore the path used by submission");
    assert(document.execCommand("redo"), "native chip redo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0, "redo retained a deleted attachment");
    assert(document.execCommand("undo"), "second native chip undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 1, "repeated undo lost the attachment");
    render("paste-b");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0, "undo metadata leaked into another chat");
    render("paste-a");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.some(r => r.path === "src/main.ts"),
      "the restored reference did not survive a chat round-trip");
    const restoredEditor = controller.ref.current!;
    restoredEditor.focus();
    select(restoredEditor, 8, 9);
    assert(document.execCommand("delete"), "second chip deletion unavailable");
    await new Promise(requestAnimationFrame);
    assert(document.execCommand("insertText", false, "\uE050"), "private-use text insertion unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0,
      "typing a removed chip's token must not resurrect an attachment");

    // A batched away-and-back project change must invalidate deleted history,
    // too: native undo must never attach the old relative path to a new context.
    const priorWorkspace = useAppStore.getState().workspace;
    await reset("inspect \uE050 please", 8, 9);
    flushSync(() => controller.applyEditorDraft("inspect \uE050 please", [undoReference], 9));
    await new Promise(requestAnimationFrame);
    const workspaceUndoEditor = controller.ref.current!;
    workspaceUndoEditor.focus();
    select(workspaceUndoEditor, 8, 9);
    assert(document.execCommand("delete"), "workspace undo deletion unavailable");
    await new Promise(requestAnimationFrame);
    flushSync(() => {
      useAppStore.setState({ workspace: { path: "/other-project", name: "Other" } });
      useAppStore.setState({ workspace: priorWorkspace });
    });
    assert(document.execCommand("undo"), "workspace native undo unavailable");
    await new Promise(requestAnimationFrame);
    assert(controller.fileReferences.length === 0,
      "undo resurrected a reference after a batched workspace round-trip");
    flushSync(() => root.render(null));
    resetComposerDraftCache();

    await verifyComposerSubmission(imageReference.path, i18n);
    return {
      ok: true,
      fullComposerSubmissionAndOverflow: true,
      mixedShortText: true,
      multilineAndUndoRedo: true,
      fileReferenceUndoRedo: true,
      crossBreakAndChipSelection: true,
      mixedLongText: true,
      temporaryTaskTextPreview: true,
      imageOnly: true,
      nativeImageFile: true,
      imagePreviewAndKeyboard: true,
      centeredImageGallery: true,
      imageDragAndReset: true,
      separateImageAttachmentRow: true,
      imageZoomFocusAndRecovery: true,
      nativeMultipleFiles: true,
      selectionAndSessionDrafts: true,
      transcriptExcerptAppend: true,
      workspaceReferencesAcrossRemount: true,
      pendingPasteAcrossSessionSwitch: true,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    resetComposerDraftCache();
  }
};
