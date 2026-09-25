import { useLayoutEffect } from "react";
import { installComposerDeletionGuard } from "./native-deletion";
import type {
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { useComposerAutocomplete } from "../../../hooks/use-composer-autocomplete";
import { editorSelectionRange, readEditorValue } from "./editor";
import { ComposerImagePreview } from "./ComposerImagePreview";
import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";

type AutocompleteController = ReturnType<typeof useComposerAutocomplete>;

export type ComposerInputProps = {
  imagePreview?: ComposerImagePreviewController;
  inputRef: RefObject<HTMLDivElement | null>;
  value: string;
  placeholderText: string;
  placeholderKey: string;
  inputBlocked: boolean;
  pasting: boolean;
  enterToSend: boolean;
  runActive: boolean;
  composerAc: AutocompleteController;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onAcceptCompletion: (index: number) => void;
  onSubmit: (steering?: boolean) => void;
  onInsertNewline: () => void;
  onInput: (source: string, caret: number) => void;
  /** Terminal-style recall; returns true when the arrow key was consumed. */
  onHistoryNavigate: (direction: "older" | "newer") => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (event: FormEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
};

/** Rich contenteditable input; draft state and async operations stay outside. */
export function ComposerInput({
  imagePreview,
  inputRef,
  value,
  placeholderText,
  placeholderKey,
  inputBlocked,
  pasting,
  enterToSend,
  runActive,
  composerAc,
  onPaste,
  onAcceptCompletion,
  onSubmit,
  onInsertNewline,
  onInput,
  onHistoryNavigate,
  onCompositionStart,
  onCompositionEnd,
  onFocus,
  onBlur,
}: ComposerInputProps) {
  useLayoutEffect(() => {
    const editor = inputRef.current;
    return editor ? installComposerDeletionGuard(editor) : undefined;
  }, [inputRef]);
  return (
    <div className="composer-input-wrap">
      {imagePreview ? <ComposerImagePreview controller={imagePreview} /> : null}
      <div className="composer-input-stage">
        {/* React does not render children into this node; the editor module
          paints atomic attachment chips imperatively. */}
        <div
          ref={inputRef}
          className="composer-input"
          role="textbox"
          aria-multiline="true"
          aria-readonly={inputBlocked}
          aria-busy={pasting}
          aria-placeholder={placeholderText}
          contentEditable={!inputBlocked}
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          translate="no"
          onPaste={onPaste}
          onBeforeInput={(event) => {
            const native = event.nativeEvent as InputEvent;
            if (
              native.inputType === "insertParagraph" ||
              native.inputType === "insertLineBreak"
            ) {
              event.preventDefault();
              onInsertNewline();
            }
          }}
          onInput={(event) => {
            const element = event.currentTarget;
            const source = readEditorValue(element);
            const { start } = editorSelectionRange(element);
            onInput(source, start);
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            // An Enter that confirms an IME candidate must commit text, never
            // send it or drive autocomplete (D125).
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter" && event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              composerAc.close();
              onSubmit(runActive);
              return;
            }
            if (composerAc.open && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              composerAc.close();
              return;
            }
            if (composerAc.hasItems) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const count = composerAc.items.length;
                composerAc.setHighlight(
                  (composerAc.highlight + delta + count) % count,
                );
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault();
                onAcceptCompletion(composerAc.highlight);
                return;
              }
            }
            if (
              (event.key === "ArrowUp" || event.key === "ArrowDown") &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              onHistoryNavigate(event.key === "ArrowUp" ? "older" : "newer")
            ) {
              event.preventDefault();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              (enterToSend || event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {value.length === 0 ? (
          <span
            key={placeholderKey}
            className="composer-placeholder"
            aria-hidden="true"
          >
            {placeholderText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export type ComposerInputStateSetters = {
  setComposing: Dispatch<SetStateAction<boolean>>;
  setInputFocused: Dispatch<SetStateAction<boolean>>;
};
