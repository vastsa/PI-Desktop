import { editorIndexAt, editorSelectionRange, readEditorValue, setEditorCaret } from "./editor";

type DeletionSnapshot = { expected: string; breaks: Set<HTMLBRElement> };

/** Preserve native deletion/undo; remove only a proven extra Chromium placeholder. */
export function installComposerDeletionGuard(editor: HTMLElement): () => void {
  // Chromium reuses its original BR node on redo. Remember only nodes proven
  // spurious, never a string pattern that could also be an intentional newline.
  const placeholders = new WeakSet<HTMLBRElement>();
  let snapshot: DeletionSnapshot | null = null;
  const beforeInput = (event: InputEvent) => {
    snapshot = null;
    if (event.isComposing || !event.inputType.startsWith("delete")) return;
    const range = event.getTargetRanges()[0];
    if (!range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    const before = readEditorValue(editor);
    const start = editorIndexAt(editor, range.startContainer, range.startOffset);
    const end = editorIndexAt(editor, range.endContainer, range.endOffset);
    snapshot = {
      expected: before.slice(0, start) + before.slice(end),
      breaks: new Set(editor.querySelectorAll("br")),
    };
  };
  const input = (event: Event) => {
    const deletion = snapshot;
    snapshot = null;
    if (event instanceof InputEvent && event.inputType === "historyRedo") {
      for (const br of editor.querySelectorAll("br")) {
        if (placeholders.has(br)) br.remove();
      }
      return;
    }
    if (!(event instanceof InputEvent) || !deletion || event.isComposing || !event.inputType.startsWith("delete")) return;
    const current = readEditorValue(editor);
    if (current === deletion.expected) return;
    for (const br of editor.querySelectorAll("br")) {
      if (deletion.breaks.has(br) || !br.parentNode) continue;
      const index = editorIndexAt(editor, br.parentNode, Array.from(br.parentNode.childNodes).indexOf(br));
      if (current.slice(0, index) + current.slice(index + 1) !== deletion.expected) continue;
      const caret = editorSelectionRange(editor).start;
      placeholders.add(br);
      br.remove();
      setEditorCaret(editor, caret > index ? caret - 1 : caret);
      break;
    }
  };
  // Native beforeinput includes deletion target ranges; React's synthetic
  // beforeinput does not consistently expose deletion events. Capture input
  // before React serializes the DOM into the draft.
  editor.addEventListener("beforeinput", beforeInput);
  editor.addEventListener("input", input, true);
  return () => {
    snapshot = null;
    editor.removeEventListener("beforeinput", beforeInput);
    editor.removeEventListener("input", input, true);
  };
}
