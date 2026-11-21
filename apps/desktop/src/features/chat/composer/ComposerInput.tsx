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
import { IconChevronDown, IconChevronUp } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { editorSelectionRange, readEditorValue } from "./editor";
import { ComposerImagePreview } from "./ComposerImagePreview";
import { ComposerImageHover } from "./ComposerImageHoverPreview";
import { DirectoryReferenceCard } from "../DirectoryReferenceCard";
import type { ComposerFileReference } from "./model";
import { composerSuggestionKeyAction } from "./plugins/suggestion-keys";
import type { ComposerSuggestionView } from "./hooks/useComposerSuggestion";
import type { CompletionController } from "./hooks/useComposerCompletions";
import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";

export type ComposerInputProps = {
  imagePreview?: ComposerImagePreviewController;
  directoryReferences?: ComposerFileReference[];
  onRemoveDirectory?: (id: string) => void;
  inputRef: RefObject<HTMLDivElement | null>;
  value: string;
  placeholderText: string;
  placeholderKey: string;
  inputBlocked: boolean;
  pasting: boolean;
  enterToSend: boolean;
  runActive: boolean;
  composerAc: CompletionController;
  /**
   * The plugin suggestion on screen, if any (ADR 0333). It is drawn in the
   * placeholder layer while the draft is empty, and `Tab` / `Esc` act on it only
   * when nothing else claims those keys.
   */
  suggestion?: ComposerSuggestionView | null;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onAcceptCompletion: (index: number) => void;
  onSubmit: (steering?: boolean) => void;
  onInsertNewline: () => void;
  onInput: (source: string, caret: number, composing: boolean) => void;
  /** Terminal-style recall; returns true when the arrow key was consumed. */
  onHistoryNavigate: (direction: "older" | "newer") => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (event: FormEvent<HTMLDivElement>) => void;
  /**
   * A composition that the browser never reports as ended. A Windows Chinese
   * IME drops `compositionend` when the composing text is deleted, which
   * would otherwise leave the draft composing forever (#929). An input event
   * that is not part of a composition is proof it is over.
   */
  onSettledInput: () => void;
  onFocus: () => void;
  onBlur: () => void;
};

/** Rich contenteditable input; draft state and async operations stay outside. */
export function ComposerInput({
  imagePreview,
  directoryReferences = [],
  onRemoveDirectory,
  inputRef,
  value,
  placeholderText,
  placeholderKey,
  inputBlocked,
  pasting,
  enterToSend,
  runActive,
  composerAc,
  suggestion = null,
  onPaste,
  onAcceptCompletion,
  onSubmit,
  onInsertNewline,
  onInput,
  onHistoryNavigate,
  onCompositionStart,
  onCompositionEnd,
  onSettledInput,
  onFocus,
  onBlur,
}: ComposerInputProps) {
  useLayoutEffect(() => {
    const editor = inputRef.current;
    return editor ? installComposerDeletionGuard(editor) : undefined;
  }, [inputRef]);
  const navigation = suggestion?.navigation;
  return (
    <div className="composer-input-wrap">
      {imagePreview ? <ComposerImagePreview controller={imagePreview} /> : null}
      {imagePreview ? <ComposerImageHover controller={imagePreview} editorRef={inputRef} /> : null}
      {directoryReferences.length > 0 ? (
        <div className="directory-reference-list">
          {directoryReferences.map((reference) => (
            <DirectoryReferenceCard
              key={reference.id}
              path={reference.path}
              name={reference.name}
              disabled={inputBlocked}
              onRemove={() => onRemoveDirectory?.(reference.id)}
            />
          ))}
        </div>
      ) : null}
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
            const native = event.nativeEvent as InputEvent;
            // An input outside a composition proves the previous one ended,
            // even when the IME never sent compositionend (#929).
            if (!native.isComposing) onSettledInput();
            onInput(source, start, native.isComposing);
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={(event) => {
            const element = event.currentTarget;
            const source = readEditorValue(element);
            const { start } = editorSelectionRange(element);
            onCompositionEnd(event);
            onInput(source, start, false);
          }}
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
            // A completion list owns `Tab` and the first `Escape`; the plugin
            // suggestion only acts once neither claims the key.
            const suggestionAction = composerSuggestionKeyAction(event, {
              suggestion: suggestion !== null,
              candidateCount: navigation?.count,
              completionItems: composerAc.hasItems,
              completionOpen: composerAc.open,
            });
            if (suggestionAction && suggestion) {
              if (suggestionAction === "dismiss") {
                event.preventDefault();
                event.stopPropagation();
                suggestion.dismiss();
                return;
              }
              const handled = suggestionAction === "accept"
                ? suggestion.accept()
                : navigation?.cycle(suggestionAction === "previous" ? -1 : 1);
              if (handled) {
                event.preventDefault();
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
        {/* The plugin suggestion (`pi.composer.suggest`) rides in the
          placeholder layer — never a bubble — and only while the draft is
          empty, which is what makes Tab a plain "write this for me". */}
        {value.length === 0 ? (
          suggestion ? (
            <span className="composer-placeholder composer-placeholder-suggestion">
              <span className="composer-suggestion-text" aria-hidden="true">{suggestion.text}</span>
              <span className="composer-suggestion-hint" aria-hidden="true">{suggestion.hint}</span>
              {navigation ? (
                <span
                  className="composer-suggestion-navigation"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || event.nativeEvent.isComposing ||
                        event.altKey || event.ctrlKey || event.metaKey) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (composerAc.open) composerAc.close();
                    else suggestion.dismiss();
                    inputRef.current?.focus();
                  }}
                >
                  <TooltipButton
                    className="composer-suggestion-nav-button"
                    type="button"
                    tooltip={navigation.previousLabel}
                    aria-keyshortcuts="ArrowUp"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigation.cycle(-1)}
                  >
                    <IconChevronUp size={12} aria-hidden="true" />
                  </TooltipButton>
                  <span className="composer-suggestion-position" aria-hidden="true">{navigation.position}</span>
                  <TooltipButton
                    className="composer-suggestion-nav-button"
                    type="button"
                    tooltip={navigation.nextLabel}
                    aria-keyshortcuts="ArrowDown"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigation.cycle(1)}
                  >
                    <IconChevronDown size={12} aria-hidden="true" />
                  </TooltipButton>
                </span>
              ) : null}
            </span>
          ) : (
            <span
              key={placeholderKey}
              className="composer-placeholder"
              aria-hidden="true"
            >
              {placeholderText}
            </span>
          )
        ) : null}
        {/* The visible line is decoration; the live region is what a screen
          reader announces, once, without stealing focus. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {suggestion ? `${navigation ? `${navigation.position}: ` : ""}${suggestion.text}` : ""}
        </span>
      </div>
    </div>
  );
}

export type ComposerInputStateSetters = {
  setComposing: Dispatch<SetStateAction<boolean>>;
  setInputFocused: Dispatch<SetStateAction<boolean>>;
};
