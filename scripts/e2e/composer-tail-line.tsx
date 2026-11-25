/**
 * Fixture for the composer's empty last line (#2433, #2555).
 *
 * Mounts the production `useComposerDraft` + `useComposerCompletions` +
 * `ComposerInput` wiring so the real hook layouts run, and exposes the draft, the
 * painted line boxes and the caret's draft index for a CDP-driven key sequence.
 */
import { createRoot } from "react-dom/client";
import { createInstance, type TFunction } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useComposerDraft } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { editorSelectionRange } from "../../apps/desktop/src/features/chat/composer/editor";

type Snapshot = {
  value: string;
  dom: string;
  caret: number;
  /** Distinct painted line tops of a range over the whole editor. */
  lineTops: number[];
  /** Invisible code points present in the editable. */
  invisibleChars: string[];
};

declare global {
  var composerTailState: () => Promise<Snapshot>;
  var composerTailReset: (text: string) => Promise<void>;
  var composerTailLinePoint: (line: number) => { x: number; y: number };
}

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;
const i18n = createInstance();
let draftValue = "";

function Fixture() {
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: "s1",
    workspacePath: "/ws",
    sessions: [{ id: "s1" }],
    composerPrefill: null,
    clearComposerPrefill: noop,
    t,
    invalidateComposerTransforms: noop,
    inputBlocked: false,
  });
  const completions = useComposerCompletions({
    value: draft.value,
    cursor: draft.cursor,
    composing: draft.composing,
    enabled: true,
    referenceSessionId: "s1",
    fileReferencesRef: draft.fileReferencesRef,
    applyEditorDraft: draft.applyEditorDraft,
    handleInput: draft.handleInput,
    invalidateComposerTransforms: noop,
  });
  draftValue = draft.value;
  globalThis.composerTailReset = async (text: string) => {
    draft.setComposing(false);
    draft.applyEditorDraft(text, [], text.length);
    await frames(2);
  };
  return (
    <I18nextProvider i18n={i18n}>
      <ComposerInput
        inputRef={draft.ref}
        value={draft.value}
        placeholderText=""
        placeholderKey="tail"
        inputBlocked={false}
        pasting={false}
        enterToSend={false}
        runActive={false}
        composerAc={completions.ac}
        onPaste={noop}
        onAcceptCompletion={completions.acceptCompletion}
        onSubmit={noop}
        onInsertNewline={() => draft.insertNewlineInEditor()}
        onHistoryNavigate={() => false}
        onInput={(source, caret, composing) => completions.handleInput(source, caret, composing)}
        onCompositionStart={() => draft.setComposing(true)}
        onCompositionEnd={() => draft.setComposing(false)}
        onSettledInput={() => draft.setComposing(false)}
        onFocus={noop}
        onBlur={noop}
      />
    </I18nextProvider>
  );
}

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => (left <= 0 ? resolve() : ((left -= 1), requestAnimationFrame(step)));
    requestAnimationFrame(step);
  });
}

const INVISIBLE = new Set([0x200b, 0xfeff, 0x00a0]);

function editor(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".composer-input");
  if (!element) throw new Error("composer input missing");
  return element;
}

function describe(value: string): Snapshot {
  const element = editor();
  const range = document.createRange();
  range.selectNodeContents(element);
  const lineTops = Array.from(
    new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))),
  ).sort((a, b) => a - b);
  const invisibleChars: string[] = [];
  for (const char of element.textContent ?? "") {
    const code = char.codePointAt(0) ?? 0;
    if (INVISIBLE.has(code)) invisibleChars.push(`U+${code.toString(16)}`);
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !element.contains(selection.anchorNode)) {
    throw new Error("Expected a collapsed native selection inside the composer");
  }
  return {
    value,
    dom: element.innerHTML,
    caret: editorSelectionRange(element).start,
    lineTops,
    invisibleChars,
  };
}

globalThis.composerTailState = async () => {
  await frames(2);
  return describe(draftValue);
};

globalThis.composerTailLinePoint = (line: number) => {
  const element = editor();
  const rect = element.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  return { x: rect.right - 4, y: rect.top + lineHeight * (line - 0.5) };
};

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
