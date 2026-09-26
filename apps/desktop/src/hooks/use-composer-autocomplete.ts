import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCompletion,
  compareMatches,
  detectTrigger,
  fileReferenceLabel,
  findAgentMentions,
  formatCommandInsert,
  formatFileInsert,
  fuzzyMatchCommand,
  fuzzyMatchPath,
  selectBestMatches,
  type ComposerAgent,
  type ComposerCommand,
  type ComposerTrigger,
  type FsIndexEntry,
  type FuzzyMatch,
  type Mode,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";

/**
 * Composer autocomplete state machine (D123–D125): trigger detection over
 * draft+cursor, lazily fetched command/file sources, local fuzzy filtering,
 * and insert-on-accept. IME freezing and key routing live in the Composer;
 * this hook only refuses to update while `composing` is true.
 */

const MAX_FILE_ITEMS = 50;
/** Stable empty list so a mode without delegation keeps a constant reference. */
const EMPTY_AGENTS: ComposerAgent[] = [];
const SOURCE_TTL_MS = 10_000;

export type AutocompleteItem =
  | { kind: "command"; command: ComposerCommand; match: FuzzyMatch }
  | { kind: "agent"; agent: ComposerAgent; match: FuzzyMatch }
  | { kind: "path"; entry: FsIndexEntry; match: FuzzyMatch };

/** Module-level TTL caches so re-triggering stays IPC-free. */
let commandsCache: {
  key: string;
  at: number;
  commands: ComposerCommand[];
  agents: ComposerAgent[];
} | null = null;
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
  skill: 4,
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

/**
 * Rank delegates for the "@" menu. Agents lead the file rows because naming one
 * is the rarer intent than pointing at a file, and the group sits above them.
 */
function filterAgents(agents: ComposerAgent[], query: string): AutocompleteItem[] {
  const matched: Array<{ agent: ComposerAgent; match: FuzzyMatch; sortText: string }> = [];
  for (const agent of agents) {
    const byName = fuzzyMatchCommand(query, agent.name);
    if (byName) {
      matched.push({ agent, match: byName, sortText: agent.name });
      continue;
    }
    const byDescription = agent.description
      ? fuzzyMatchCommand(query, agent.description)
      : null;
    if (byDescription) {
      matched.push({
        agent,
        match: { score: Math.max(0, byDescription.score - 20), ranges: [] },
        sortText: agent.name,
      });
    }
  }
  matched.sort((a, b) =>
    compareMatches(
      { score: a.match.score, text: a.sortText },
      { score: b.match.score, text: b.sortText },
    ),
  );
  return matched.map(({ agent, match }) => ({ kind: "agent", agent, match }));
}

/**
 * Whether the menu has everything it needs to open.
 *
 * The agent group is a source like the file index, but its absence must never
 * stall the menu: in Plan/Goal no catalog read is started at all, so that
 * source counts as resolved. Split out because getting this wrong either
 * flashes an empty menu or never opens one, and neither is visible in a
 * screenshot.
 */
export function composerSourcesReady({
  mode,
  hasWorkspace,
  filesLoaded,
  agentsResolved,
}: {
  mode: Mode;
  hasWorkspace: boolean;
  filesLoaded: boolean;
  agentsResolved: boolean;
}): boolean {
  if (mode !== "agent") return filesLoaded || !hasWorkspace;
  return hasWorkspace ? filesLoaded && agentsResolved : agentsResolved;
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
export async function resolveComposerCommand(
  name: string,
): Promise<ComposerCommandResolution> {
  const key = useAppStore.getState().workspace?.path ?? "";
  if (
    !commandsCache ||
    commandsCache.key !== key ||
    Date.now() - commandsCache.at > SOURCE_TTL_MS
  ) {
    try {
      const res = await api.composerCommands();
      commandsCache = {
        key,
        at: Date.now(),
        commands: res.commands,
        agents: res.agents ?? [],
      };
    } catch (error) {
      // Deliberately leaves the cache cold: the next attempt re-reads the
      // source, which is what makes the refusal retriable.
      return {
        status: "unavailable",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  const command = commandsCache?.commands.find((c) => c.name === name);
  return command ? { status: "resolved", command } : { status: "unknown" };
}

/**
 * Names the delegates a draft asks for, read from the same warm cache the menu
 * uses.
 *
 * The submit path calls this only to decide whether a non-Agent mode must
 * refuse the turn. It deliberately does not resolve files: a draft where
 * `@explorer` is a real file must still be sendable, and main re-runs the
 * authoritative resolution anyway.
 */
export async function resolveComposerAgentMentions(
  content: string,
): Promise<string[]> {
  if (!/(^|\s)@\S/.test(content)) return [];
  const key = useAppStore.getState().workspace?.path ?? "";
  if (
    !commandsCache ||
    commandsCache.key !== key ||
    Date.now() - commandsCache.at > SOURCE_TTL_MS
  ) {
    try {
      const res = await api.composerCommands();
      commandsCache = {
        key,
        at: Date.now(),
        commands: res.commands,
        agents: res.agents ?? [],
      };
    } catch {
      // A catalog that cannot be read proves nothing about the draft, so the
      // turn is left to main, which sends literal text on a failed read.
      return [];
    }
  }
  return findAgentMentions(
    content,
    new Set(commandsCache.agents.map((agent) => agent.name)),
  ).map((mention) => mention.name);
}

export function useComposerAutocomplete({
  value,
  cursor,
  composing,
  enabled,
  mode,
}: {
  value: string;
  cursor: number;
  composing: boolean;
  enabled: boolean;
  /** Session mode. `Task` exists only in Agent mode, so only that mode lists agents. */
  mode: Mode;
}) {
  const workspaceKey = useAppStore((s) => s.workspace?.path ?? "");
  const hasWorkspace = workspaceKey !== "";
  const [commands, setCommands] = useState<ComposerCommand[] | null>(null);
  const [files, setFiles] = useState<{
    entries: FsIndexEntry[];
    truncated: boolean;
  } | null>(null);
  // Plan and Goal are read-only contract negotiations (ADR 0062 §4); a
  // delegate with Bash or Edit would drive straight through them, so the group
  // is not offered there at all rather than failing on send.
  const agentsAllowed = mode === "agent";
  const [loadedAgents, setLoadedAgents] = useState<ComposerAgent[]>([]);
  // Readiness is a separate flag: the agent list is an array, so "loaded" and
  // "empty" cannot both be read off the same value.
  const [agentsReady, setAgentsReady] = useState(false);
  const availableAgents = agentsAllowed ? loadedAgents : EMPTY_AGENTS;
  // Outside Agent mode no catalog read is ever started, so that source counts
  // as resolved — otherwise the menu would wait on a read that never happens.
  const agentsResolved = agentsAllowed ? agentsReady : true;
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

  const loadAgents = useCallback(async () => {
    const now = Date.now();
    if (
      commandsCache &&
      commandsCache.key === workspaceKey &&
      now - commandsCache.at < SOURCE_TTL_MS
    ) {
      setLoadedAgents(commandsCache.agents);
      setAgentsReady(true);
      return;
    }
    try {
      // The same read that backs the "/" menu; its TTL cache keeps a warm menu
      // from re-reading the catalog on every keystroke.
      const res = await api.composerCommands();
      commandsCache = {
        key: workspaceKey,
        at: Date.now(),
        commands: res.commands,
        agents: res.agents ?? [],
      };
      setLoadedAgents(commandsCache.agents);
    } catch {
      setLoadedAgents([]);
    } finally {
      setAgentsReady(true);
    }
  }, [workspaceKey]);

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
          commandsCache = {
            key: workspaceKey,
            at: Date.now(),
            commands: res.commands,
            agents: res.agents ?? [],
          };
          if (!cancelled) setCommands(res.commands);
        })
        .catch(() => {
          if (!cancelled) setCommands([]);
        });
      return () => {
        cancelled = true;
      };
    }
    // The "@" menu carries agents alongside files, so the delegation catalog
    // is read even with no workspace open: a user can delegate in a
    // workspace-less session, and the group is the menu's first section.
    if (agentsAllowed) void loadAgents();
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
  }, [trigger?.mode, dismissed, workspaceKey, hasWorkspace, agentsAllowed, loadAgents]);

  const items = useMemo<AutocompleteItem[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.mode === "slash") {
      return commands ? filterCommands(commands, trigger.query, trigger.tokenStart > 0) : [];
    }
    // Agents precede files so the group reads as its own section.
    const agentItems = filterAgents(availableAgents, trigger.query);
    return agentItems.length
      ? [...agentItems, ...(files ? filterFiles(files.entries, trigger.query) : [])]
      : files
        ? filterFiles(files.entries, trigger.query)
        : [];
  }, [trigger, dismissed, commands, files, availableAgents]);

  // New query or mode restarts keyboard navigation at the top hit.
  const itemsKey = trigger ? `${trigger.mode}:${trigger.query}` : "";
  useEffect(() => {
    setHighlight(0);
  }, [itemsKey]);

  const sourceReady =
    !!trigger &&
    (trigger.mode === "slash"
      ? commands !== null
      : composerSourcesReady({
          mode,
          hasWorkspace,
          filesLoaded: files !== null,
          agentsResolved,
        }));
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
          agentReference?: { name: string; description?: string };
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
      if (item.kind === "agent") {
        // Atomic chip, like a completed file: the delegate is one thing the
        // user picked, so it reads and deletes as one thing rather than as
        // editable `@name` text they could half-erase.
        return {
          ...applyCompletion(value, trigger, ""),
          agentReference: {
            name: item.agent.name,
            ...(item.agent.description ? { description: item.agent.description } : {}),
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
    noWorkspace:
      open && trigger?.mode === "file" && !hasWorkspace && items.length === 0,
    close,
    accept,
  };
}
