/**
 * The composer's view of the plugin suggestion slot (ADR 0333).
 *
 * The state itself lives in `../plugins/suggestion-bridge.ts`, outside React, so
 * a suggestion that arrives while the composer is unmounted is refused once
 * instead of queued; this only subscribes a mounted composer to it and hands the
 * placeholder layer the line and the key hint it draws.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { composerSuggestion } from "../plugins/suggestion-bridge";

/** What `ComposerInput` draws and does while a suggestion is on screen. */
export type ComposerSuggestionView = {
  readonly text: string;
  /** `Tab` / `Esc` hint drawn beside the line, in the shell's language. */
  readonly hint: string;
  /** Take it: the draft becomes the text and the caret lands at its end. */
  accept(): boolean;
  dismiss(): void;
};

const subscribe = (listener: () => void) => composerSuggestion.subscribe(listener);
const snapshot = () => composerSuggestion.get();
/**
 * There is no shell state to read while the app is rendered to a string, and
 * React requires this third snapshot for exactly that pass: a suggestion is a
 * live-window fact, so a server render starts with none.
 */
const serverSnapshot = (): null => null;

export function useComposerSuggestion(): ComposerSuggestionView | null {
  const { t } = useTranslation();
  const suggestion = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const text = suggestion?.text ?? "";
  const hint = t("chat.suggestionHint");
  return useMemo(
    () =>
      suggestion
        ? {
            text,
            hint,
            accept: () => composerSuggestion.accept(),
            dismiss: () => composerSuggestion.dismiss(),
          }
        : null,
    [suggestion, text, hint],
  );
}
