import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCompletion,
  compareMatches,
  detectTrigger,
  fileReferenceLabel,
  formatCommandInsert,
  formatFileInsert,
  fuzzyMatchCommand,
  fuzzyMatchPath,
  selectBestMatches,
  type ComposerCommand,
  type ComposerTrigger,
  type FsIndexEntry,
  type FuzzyMatch,
} from "@pi-desktop/shared";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

/**
 * Composer autocomplete state machine (D123–D125): trigger detection over
 * draft+cursor, lazily fetched command/file sources, local fuzzy filtering,
 * and insert-on-accept. IME freezing and key routing live in the Composer;
 * this hook only refuses to update while `composing` is true.
 */

const MAX_FILE_ITEMS = 50;
const SOURCE_TTL_MS = 10_000;

export type AutocompleteItem =
  | { kind: "command"; command: ComposerCommand; match: FuzzyMatch }
  | { kind: "path"; entry: FsIndexEntry; match: FuzzyMatch };

/** Module-level TTL caches so re-triggering stays IPC-free. */
let commandsCache: { key: string; at: number; commands: ComposerCommand[] } | null =
  null;
let filesCache: {
  key: string;
  at: number;
  entries: FsIndexEntry[];
  truncated: boolean;
} | null = null;

const COMMAND_GROUP_ORDER = { template: 0, builtin: 1, plugin: 2 } as const;

function filterCommands(
  commands: ComposerCommand[],
  query: string,
): AutocompleteItem[] {
  const matched: Array<{
    command: ComposerCommand;
    match: FuzzyMatch;
    sortText: string;
  }> = [];
  for (const command of commands) {
    const byName = fuzzyMatchCommand(query, command.name);
    if (byName) {
      matched.push({ command, match: byName, sortText: command.name });
      continue;
    }
    // Title/description hits keep the row findable, without name highlights.
    const byTitle =
      fuzzyMatchCommand(query, command.title) ??
      (command.description
        ? fuzzyMatchCommand(query, command.description)
        : null);
    if (byTitle) {
      matched.push({
        command,
        match: { score: Math.max(0, byTitle.score - 20), ranges: [] },
        sortText: command.name,
      });
    }
  }
  matched.sort((a, b) => {
    const groupDelta =
      COMMAND_GROUP_ORDER[a.command.kind] - COMMAND_GROUP_ORDER[b.command.kind];
    if (groupDelta !== 0) return groupDelta;
    return compareMatches(
      { score: a.match.score, text: a.sortText },
      { score: b.match.score, text: b.sortText },
    );
  });
  return matched.map(({ command, match }) => ({ kind: "command", command, match }));
}

function filterFiles(entries: FsIndexEntry[], query: string): AutocompleteItem[] {
  const matched: Array<{ entry: FsIndexEntry; match: FuzzyMatch }> = [];
  for (const entry of entries) {
    const match = fuzzyMatchPath(query, entry.path, entry.kind);
    if (match) matched.push({ entry, match });
  }
  // The index can hold thousands of entries while the menu shows at most
  // MAX_FILE_ITEMS, so only the bounded top slice is ever ordered.
  return selectBestMatches(matched, MAX_FILE_ITEMS, ({ entry, match }) => ({
    score: match.score,
    text: entry.path,
  })).map(({ entry, match }) => ({ kind: "path", entry, match }));
}

/**
 * Resolve a typed "/name" against the merged command list at send time
 * (builtin/plugin dispatch); templates and unknown names return as-is/null
 * and stay on the prompt path. Reuses the menu's TTL cache when warm.
 */
export async function resolveComposerCommand(
  name: string,
): Promise<ComposerCommand | null> {
  const key = useAppStore.getState().workspace?.path ?? "";
  if (
    !commandsCache ||
    commandsCache.key !== key ||
    Date.now() - commandsCache.at > SOURCE_TTL_MS
  ) {
    try {
      const res = await api.composerCommands();
      commandsCache = { key, at: Date.now(), commands: res.commands };
    } catch {
      return null;
    }
  }
  return commandsCache.commands.find((c) => c.name === name) ?? null;
}

export function useComposerAutocomplete({
  value,
  cursor,
  composing,
  enabled,
}: {
  value: string;
  cursor: number;
  composing: boolean;
  enabled: boolean;
}) {
  const workspaceKey = useAppStore((s) => s.workspace?.path ?? "");
  const hasWorkspace = workspaceKey !== "";
  const [commands, setCommands] = useState<ComposerCommand[] | null>(null);
  const [files, setFiles] = useState<{
    entries: FsIndexEntry[];
    truncated: boolean;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const frozenRef = useRef<ComposerTrigger | null>(null);

  const liveTrigger = useMemo(
    () => (enabled ? detectTrigger(value, cursor) : null),
    [enabled, value, cursor],
  );
  // During IME composition the menu freezes: no opening, closing, or
  // re-filtering until compositionend re-evaluates (D125).
  const trigger = composing ? frozenRef.current : liveTrigger;
  useEffect(() => {
    if (!composing) frozenRef.current = liveTrigger;
  }, [composing, liveTrigger]);

  const triggerKey = trigger ? `${trigger.mode}:${trigger.tokenStart}` : null;
  const dismissed = triggerKey !== null && triggerKey === dismissedKey;

  // Escape-dismissal clears once the trigger token goes away.
  useEffect(() => {
    if (dismissedKey && triggerKey !== dismissedKey) setDismissedKey(null);
  }, [triggerKey, dismissedKey]);

  // Lazy source fetch with a short TTL, keyed by workspace.
  useEffect(() => {
    if (!trigger || dismissed) return;
    const now = Date.now();
    if (trigger.mode === "slash") {
      if (
        commandsCache &&
        commandsCache.key === workspaceKey &&
        now - commandsCache.at < SOURCE_TTL_MS
      ) {
        setCommands(commandsCache.commands);
        return;
      }
      let cancelled = false;
      void api
        .composerCommands()
        .then((res) => {
          commandsCache = { key: workspaceKey, at: Date.now(), commands: res.commands };
          if (!cancelled) setCommands(res.commands);
        })
        .catch(() => {
          if (!cancelled) setCommands([]);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!hasWorkspace) {
      setFiles({ entries: [], truncated: false });
      return;
    }
    if (
      filesCache &&
      filesCache.key === workspaceKey &&
      now - filesCache.at < SOURCE_TTL_MS
    ) {
      setFiles({ entries: filesCache.entries, truncated: filesCache.truncated });
      return;
    }
    let cancelled = false;
    void api
      .fsIndex()
      .then((res) => {
        filesCache = {
          key: workspaceKey,
          at: Date.now(),
          entries: res.entries,
          truncated: res.truncated,
        };
        if (!cancelled) setFiles({ entries: res.entries, truncated: res.truncated });
      })
      .catch(() => {
        if (!cancelled) setFiles({ entries: [], truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [trigger?.mode, dismissed, workspaceKey, hasWorkspace]);

  const items = useMemo<AutocompleteItem[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.mode === "slash") {
      return commands ? filterCommands(commands, trigger.query) : [];
    }
    return files ? filterFiles(files.entries, trigger.query) : [];
  }, [trigger, dismissed, commands, files]);

  // New query or mode restarts keyboard navigation at the top hit.
  const itemsKey = trigger ? `${trigger.mode}:${trigger.query}` : "";
  useEffect(() => {
    setHighlight(0);
  }, [itemsKey]);

  const sourceReady =
    !!trigger &&
    (trigger.mode === "slash" ? commands !== null : files !== null);
  const open = !!trigger && !dismissed && sourceReady;

  const close = useCallback(() => {
    if (triggerKey) setDismissedKey(triggerKey);
  }, [triggerKey]);

  const accept = useCallback(
    (
      index: number,
    ):
      | {
          value: string;
          cursor: number;
          fileReference?: { path: string; name: string };
        }
      | null => {
      if (!trigger) return null;
      const item = items[index];
      if (!item) return null;
      if (item.kind === "path" && item.entry.kind === "file") {
        return {
          ...applyCompletion(value, trigger, ""),
          fileReference: {
            path: item.entry.path,
            name: fileReferenceLabel(item.entry.path),
          },
        };
      }
      const insert =
        item.kind === "command"
          ? formatCommandInsert(item.command.name)
          : formatFileInsert(item.entry.path, item.entry.kind);
      return applyCompletion(value, trigger, insert);
    },
    [trigger, items, value],
  );

  return {
    open,
    mode: open && trigger ? trigger.mode : null,
    query: open && trigger ? trigger.query : "",
    items: open ? items : [],
    hasItems: open && items.length > 0,
    highlight,
    setHighlight,
    truncated: open && trigger?.mode === "file" ? (files?.truncated ?? false) : false,
    noWorkspace: open && trigger?.mode === "file" && !hasWorkspace,
    close,
    accept,
  };
}
