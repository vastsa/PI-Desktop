/**
 * The composer's completion list: the host's own `/` commands and `@` files
 * (`useComposerAutocomplete`) followed by the group of the plugin owning the
 * typed symbol (`composerTrigger`, `docs/plugin-plan/ui/composer/`), and
 * what accepting a row does to the draft.
 *
 * A plugin trigger only answers the user's typing: it is off while an IME
 * composes (the list freezes like the host's), while the input is blocked,
 * and whenever the draft is not the text the user last typed, so a program's
 * write never opens it. A provider that throws, rejects or takes too long
 * collapses only its own group.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  useComposerAutocomplete,
  type AutocompleteItem,
} from "../../../../hooks/use-composer-autocomplete";
import { slotRegistry } from "../../../../plugins/renderer-slots/registry";
import { useAppStore } from "../../../../stores/app-store";
import { createFileReference, isImageFilePath, nextChipToken } from "../editor";
import type { ComposerFileReference } from "../model";
import { placePluginMark } from "../plugins/plugin-marks";
import {
  askPluginTrigger,
  detectPluginTrigger,
  type PluginTriggerMatch,
  type PluginTriggerRow,
} from "../plugins/plugin-triggers";

export type PluginCompletionItem = {
  kind: "plugin";
  pluginId: string;
  /** The plugin's display name, the group's heading. */
  pluginName: string;
  row: PluginTriggerRow;
};

export type CompletionItem = AutocompleteItem | PluginCompletionItem;

export type CompletionController = {
  open: boolean;
  /** The host's mode, or `plugin` when only a plugin's group is listed. */
  mode: "slash" | "file" | "plugin" | null;
  items: CompletionItem[];
  hasItems: boolean;
  highlight: number;
  setHighlight: (index: number) => void;
  truncated: boolean;
  noWorkspace: boolean;
  close: () => void;
};

type PluginAnswer = { key: string; rows: PluginTriggerRow[] | null };

const NO_ITEMS: AutocompleteItem[] = [];

export function useComposerCompletions({
  value,
  cursor,
  composing,
  enabled,
  referenceSessionId,
  fileReferencesRef,
  applyEditorDraft,
  handleInput,
  invalidatePromptEnhancement,
}: {
  value: string;
  cursor: number;
  composing: boolean;
  enabled: boolean;
  referenceSessionId: string;
  fileReferencesRef: RefObject<ComposerFileReference[]>;
  applyEditorDraft: (text: string, references: ComposerFileReference[], caret: number) => void;
  handleInput: (source: string, caret: number) => string;
  invalidatePromptEnhancement: () => void;
}) {
  const host = useComposerAutocomplete({ value, cursor, composing, enabled });
  const { triggers } = useSyncExternalStore(
    slotRegistry.subscribe,
    slotRegistry.getSnapshot,
    slotRegistry.getSnapshot,
  );
  const plugins = useAppStore((state) => state.plugins);
  const [typedValue, setTypedValue] = useState<string | null>(null);
  const [answer, setAnswer] = useState<PluginAnswer | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const frozenRef = useRef<PluginTriggerMatch | null>(null);

  const liveMatch = useMemo(
    () =>
      enabled && value === typedValue
        ? detectPluginTrigger(value, cursor, new Set(triggers.map((entry) => entry.trigger)))
        : null,
    [enabled, value, typedValue, cursor, triggers],
  );
  const match = composing ? frozenRef.current : liveMatch;
  useEffect(() => {
    if (!composing) frozenRef.current = liveMatch;
  }, [composing, liveMatch]);

  const entry = match ? triggers.find((candidate) => candidate.trigger === match.trigger) : undefined;
  const tokenKey = entry && match ? `${entry.id}:${match.tokenStart}` : null;
  const requestKey = tokenKey && match ? `${tokenKey}:${match.query}` : null;
  const dismissed = tokenKey !== null && tokenKey === dismissedKey;

  useEffect(() => {
    if (dismissedKey && tokenKey !== dismissedKey) setDismissedKey(null);
  }, [tokenKey, dismissedKey]);

  useEffect(() => {
    if (!entry || !match || !requestKey || dismissed) return;
    let current = true;
    void askPluginTrigger(entry.items, match, entry.pluginId).then((rows) => {
      if (current) setAnswer({ key: requestKey, rows });
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey names entry and match
  }, [requestKey, dismissed]);

  const pluginItems = useMemo<PluginCompletionItem[]>(() => {
    if (!entry || dismissed || !answer || answer.key !== requestKey) return [];
    const pluginName =
      plugins.find((plugin) => plugin.id === entry.pluginId)?.name ?? entry.pluginId;
    return (answer.rows ?? []).map((row) => ({
      kind: "plugin",
      pluginId: entry.pluginId,
      pluginName,
      row,
    }));
  }, [entry, dismissed, answer, requestKey, plugins]);

  const hostItems = host.open ? host.items : NO_ITEMS;
  const items = useMemo<CompletionItem[]>(
    () => [...hostItems, ...pluginItems],
    [hostItems, pluginItems],
  );

  // A new query restarts keyboard navigation at the top hit.
  const itemsKey = `${host.mode}:${host.query}|${requestKey}`;
  useEffect(() => {
    setHighlight(0);
  }, [itemsKey]);

  const hostClose = host.close;
  const close = useCallback(() => {
    hostClose();
    if (tokenKey) setDismissedKey(tokenKey);
  }, [hostClose, tokenKey]);

  const open = host.open || pluginItems.length > 0;
  const ac: CompletionController = {
    open,
    mode: host.mode ?? (open ? "plugin" : null),
    items,
    hasItems: items.length > 0,
    highlight: Math.min(highlight, Math.max(0, items.length - 1)),
    setHighlight,
    truncated: host.truncated,
    noWorkspace: host.noWorkspace,
    close,
  };

  const acceptCompletion = (index: number) => {
    if (index >= hostItems.length) {
      const item = pluginItems[index - hostItems.length];
      if (!item || !match) return;
      invalidatePromptEnhancement();
      const text = value.slice(0, match.tokenStart) + value.slice(match.tokenEnd);
      const placed = placePluginMark(
        fileReferencesRef.current,
        text,
        { pluginId: item.pluginId, label: item.row.label, send: item.row.send },
        referenceSessionId,
      );
      const token = placed.token ?? "";
      applyEditorDraft(
        text.slice(0, match.tokenStart) + token + text.slice(match.tokenStart),
        placed.references,
        match.tokenStart + token.length,
      );
      return;
    }
    const result = host.accept(index);
    if (!result) return;
    invalidatePromptEnhancement();
    // File accept strips the @ token (empty insert) and used to store a
    // token-less chip above the textarea. Inline chips only paint when a
    // sentinel is in the draft, so Enter looked like the reference vanished.
    const acceptedFileReference = result.fileReference;
    if (!acceptedFileReference) {
      applyEditorDraft(result.value, fileReferencesRef.current, result.cursor);
      return;
    }
    const token = nextChipToken();
    const nextText =
      result.value.slice(0, result.cursor) + token + result.value.slice(result.cursor);
    applyEditorDraft(
      nextText,
      [
        ...fileReferencesRef.current,
        createFileReference(
          acceptedFileReference.path,
          acceptedFileReference.name,
          referenceSessionId,
          {
            kind: isImageFilePath(acceptedFileReference.path) ? "image" : "file",
            token,
          },
        ),
      ],
      result.cursor + token.length,
    );
  };

  /** The draft's input handler, noting what the user typed. */
  const handleTypedInput = (source: string, caret: number) => {
    setTypedValue(handleInput(source, caret));
  };

  return { ac, acceptCompletion, handleInput: handleTypedInput };
}
