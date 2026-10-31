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
import { api } from "../lib/api";
import {
  commandsForSession,
  fetchComposerCommands,
  prewarmComposerCommands,
  readComposerCommandsCache,
} from "../lib/composer-command-source";
import { useAppStore } from "../stores/app-store";

/**
 * Composer autocomplete state machine (D123–D125): trigger detection over
 * draft+cursor, lazily fetched command/file sources, local fuzzy filtering
 * (with a main-process search past a truncated file index, D669), and
 * insert-on-accept. IME freezing and key routing live in the Composer;
 * this hook only refuses to update while `composing` is true.
 */

const MAX_FILE_ITEMS = 50;
const SOURCE_TTL_MS = 10_000;
/** Typing pause before a query searches past a truncated file index. */
const FILE_SEARCH_DEBOUNCE_MS = 150;

export type AutocompleteItem =
  | { kind: "command"; command: ComposerCommand; match: FuzzyMatch }
  | { kind: "path"; entry: FsIndexEntry; match: FuzzyMatch };

/**
 * Module-level TTL cache so re-triggering stays IPC-free. The `/` command
 * source itself lives in `lib/composer-command-source`, because the launch
 * pre-warm (#1543) must seed it before this hook mounts.
 */
let filesCache: {
  key: string;
  at: number;
  entries: FsIndexEntry[];
  truncated: boolean;
} | null = null;

const COMMAND_GROUP_ORDER = {
  template: 0,
  builtin: 1,
  plugin: 2,
  extension: 3,
  mcp: 4,
  skill: 5,
} as const;

function filterCommands(
  commands: ComposerCommand[],
  query: string,
  skillsOnly = false,
): AutocompleteItem[] {
  const matched: Array<{
    command: ComposerCommand;
    match: FuzzyMatch;
    sortText: string;
  }> = [];
  for (const command of commands) {
    if (skillsOnly && command.kind !== "skill") continue;
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
  // Rows found by the main-process search may repeat index entries.
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = fuzzyMatchPath(query, entry.path, entry.kind);
    if (!match || seen.has(entry.path)) continue;
    seen.add(entry.path);
    matched.push({ entry, match });
  }
  // The index can hold thousands of entries while the menu shows at most
  // MAX_FILE_ITEMS, so only the bounded top slice is ever ordered.
  return selectBestMatches(matched, MAX_FILE_ITEMS, ({ entry, match }) => ({
    score: match.score,
    text: entry.path,
  })).map(({ entry, match }) => ({ kind: "path", entry, match }));
}

/**
 * Result of resolving one typed "/name" at send time.
 *
 * `unavailable` is the branch that keeps a failed source read from looking like
 * "no such command": the composer can only guess whether `/compact` is a
 * builtin it must not send to the model, so it refuses the submission instead
 * of degrading a control command into prompt text (issue #795).
 */
export type ComposerCommandResolution =
  | { status: "resolved"; command: ComposerCommand }
  | { status: "unknown" }
  | { status: "unavailable"; error: Error };

/**
 * Resolve a typed "/name" against the merged command and skill list at send
 * time (builtin/plugin dispatch and skill validation); templates, non-command
 * names, and unknown names stay on the prompt path. Reuses the menu's TTL cache
 * when warm, so a warm cache keeps resolving through a source blip.
 */
/**
 * Whether the active session runs against a remote host workspace. The menu
 * and the send-time resolver share this so they offer the same commands.
 */
function activeSessionHasRemoteWorkspace(state: ReturnType<typeof useAppStore.getState>): boolean {
  return Boolean(state.sessions.find((session) => session.id === state.activeSessionId)?.remoteWorkspace);
}

export async function resolveComposerCommand(
  name: string,
): Promise<ComposerCommandResolution> {
  const key = useAppStore.getState().workspace?.path ?? "";
  let commands = readComposerCommandsCache(key);
  if (!commands) {
    try {
      commands = await fetchComposerCommands(key);
    } catch (error) {
      // Deliberately leaves the cache cold: the next attempt re-reads the
      // source, which is what makes the refusal retriable.
      return {
        status: "unavailable",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  const command = commandsForSession(commands, {
    remote: activeSessionHasRemoteWorkspace(useAppStore.getState()),
  }).find((c) => c.name === name);
  return command ? { status: "resolved", command } : { status: "unknown" };
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
  const sessionId = useAppStore((s) => s.activeSessionId);
  const remoteSession = useAppStore(activeSessionHasRemoteWorkspace);
  const workspaceKey = useAppStore((s) => s.workspace?.path ?? "");
  const hasWorkspace = workspaceKey !== "";
  const ready = useAppStore((s) => s.ready);
  const [commands, setCommands] = useState<ComposerCommand[] | null>(null);
  const [files, setFiles] = useState<{
    entries: FsIndexEntry[];
    truncated: boolean;
  } | null>(null);
  const [found, setFound] = useState<{
    scope: string;
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
      const cached = readComposerCommandsCache(workspaceKey);
      if (cached) {
        setCommands(cached);
        return;
      }
      let cancelled = false;
      void fetchComposerCommands(workspaceKey)
        .then((commands) => {
          if (!cancelled) setCommands(commands);
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
      .fsIndex(sessionId)
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
  }, [trigger?.mode, dismissed, workspaceKey, hasWorkspace, sessionId]);

  // A truncated index keeps only the shallowest entries, so a deep file of a
  // large tree matches nothing in it. Once typing pauses, the query also
  // searches the main process's full listing (D669); the answer belongs to
  // this `@` token and its rows merge with the index's.
  const fileQuery =
    trigger?.mode === "file" && !dismissed && files?.truncated ? trigger.query : "";
  const searchScope = `${sessionId ?? ""}\n${workspaceKey}\n${triggerKey ?? ""}`;
  useEffect(() => {
    if (!fileQuery) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .fsSearch(sessionId, fileQuery)
        .then((res) => {
          if (!cancelled) setFound({ scope: searchScope, ...res });
        })
        .catch(() => {
          // The index's rows still answer; the truncation note stays.
          if (!cancelled) setFound({ scope: searchScope, entries: [], truncated: true });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileQuery, searchScope, sessionId]);
  // A later `@` at the same offset is a new token and must not inherit rows.
  useEffect(() => {
    if (!triggerKey) setFound(null);
  }, [triggerKey]);
  // A bare `@` lists the index alone; searched rows belong to a typed query.
  const foundHere = fileQuery !== "" && found?.scope === searchScope ? found : null;
  const fileTruncated =
    (files?.truncated ?? false) && (!fileQuery || !foundHere || foundHere.truncated);

  // Warm the `/` source once bootstrap settles, so the first slash of a session
  // does not wait for a cold host round trip (#1543). Waiting for `ready` keeps
  // the pre-warm off the pre-hydration empty workspace key, which would spend a
  // full host assembly and then be discarded.
  useEffect(() => {
    if (!enabled || !ready) return;
    return prewarmComposerCommands(workspaceKey);
  }, [enabled, ready, workspaceKey]);

  const items = useMemo<AutocompleteItem[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.mode === "slash") {
      return commands
        ? filterCommands(
            commandsForSession(commands, { remote: remoteSession }),
            trigger.query,
            trigger.tokenStart > 0,
          )
        : [];
    }
    if (!files) return [];
    return filterFiles(
      foundHere ? [...foundHere.entries, ...files.entries] : files.entries,
      trigger.query,
    );
  }, [trigger, dismissed, commands, remoteSession, files, foundHere]);

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
    truncated: open && trigger?.mode === "file" ? fileTruncated : false,
    noWorkspace: open && trigger?.mode === "file" && !hasWorkspace,
    close,
    accept,
  };
}
