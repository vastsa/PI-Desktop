/**
 * The composer's completion list: the host's own `/` commands and `@` files
 * (`useComposerAutocomplete`) and the group of the plugin owning the typed
 * symbol (`composerTrigger`, `docs/plugin-plan/ui/composer/`) — after the
 * host's rows, or before them for a `placement: "first"` trigger — and what
 * accepting a row does to the draft.
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
import { useTranslation } from "react-i18next";
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
  orderTriggerGroups,
  pluginTriggerScope,
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
  triggerContext,
  fileReferencesRef,
  applyEditorDraft,
  handleInput,
  invalidateComposerTransforms,
}: {
  value: string;
  cursor: number;
  composing: boolean;
  enabled: boolean;
  referenceSessionId: string;
  /** The session's context use as the composer's ring shows it, told to triggers. */
  triggerContext?: { usedTokens: number; contextWindow: number } | null;
  fileReferencesRef: RefObject<ComposerFileReference[]>;
  applyEditorDraft: (text: string, references: ComposerFileReference[], caret: number) => void;
  handleInput: (source: string, caret: number) => string;
  invalidateComposerTransforms: () => void;
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
  // Session references (Settings › AI), told to triggers with the scope.
  const referenceBudgetPercent = useAppStore((state) => state.settings?.sessionReferenceBudgetPercent);
  const referenceMaxTurns = useAppStore((state) => state.settings?.sessionReferenceMaxTurns);
  const referenceSettings = {
    sessionReferenceBudgetPercent: referenceBudgetPercent,
    sessionReferenceMaxTurns: referenceMaxTurns,
  };
  // The UI language the host's own rows are drawn in, told to triggers too.
  const { i18n } = useTranslation();
  const uiLocale = i18n?.resolvedLanguage ?? i18n?.language;
  // Read when a trigger is asked, so a context or settings change alone asks nothing.
  const scopeRef = useRef(pluginTriggerScope(referenceSessionId, triggerContext, referenceSettings, uiLocale));
  scopeRef.current = pluginTriggerScope(referenceSessionId, triggerContext, referenceSettings, uiLocale);

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
    void askPluginTrigger(entry.items, match, entry.pluginId, undefined, scopeRef.current).then((rows) => {
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
  const placement = entry?.placement ?? "last";
  const items = useMemo<CompletionItem[]>(
    () => orderTriggerGroups<CompletionItem, CompletionItem>(hostItems, pluginItems, placement),
    [hostItems, pluginItems, placement],
  );

  // A new query restarts keyboard navigation at the top hit. A leading group
  // answers after the host's rows are drawn, so its arrival restarts it too:
  // its first row, not the file that briefly sat on top, is the default.
  const leads = placement === "first" && pluginItems.length > 0;
  const itemsKey = `${host.mode}:${host.query}|${requestKey}|${leads}`;
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
    const picked = items[index];
    if (!picked) return;
    if (picked.kind === "plugin") {
      const item = picked;
      if (!match) return;
      invalidateComposerTransforms();
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
    const result = host.accept(hostItems.indexOf(picked));
    if (!result) return;
    invalidateComposerTransforms();
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
