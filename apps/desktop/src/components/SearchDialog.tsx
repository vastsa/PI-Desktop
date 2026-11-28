import { OverlayBackdrop } from "./ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listableSessions } from "../lib/session-origin";
import { runPaletteCommand } from "../lib/commands";
import { isDefaultSessionTitle, useAppStore } from "../stores/app-store";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import { searchSettings, type SettingsSearchHit } from "../lib/settings-search";
import { useSessionSearch, useSessionSearchState } from "../hooks/use-session-search";
import { SearchHighlight } from "./SearchHighlight";
import { SearchSessionResults, type SearchRow } from "./SearchSessionResults";
import { ProjectFileSearchResults, type ProjectFileRow } from "./ProjectFileSearchResults";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import type { SessionSummary, CommandItem } from "@pi-desktop/shared";
import type { SessionMeta } from "../lib/sidebar-preferences";
import {
  IconAt,
  IconClock,
  IconNewSession,
  IconSearch,
  IconSettings,
  IconSliders,
} from "./icons";

/** Hits fetched per Files-tab page; the host serves any offset from one scan. */
const FILE_PAGE_SIZE = 200;

/** Navigable pages surfaced by the global search alongside sessions. */
const PAGE_ENTRIES = [
  { page: "scheduled", labelKey: "scheduled.title", icon: IconClock },
  { page: "plugins", labelKey: "nav.plugins", icon: IconAt },
] as const;

type PageEntry = (typeof PAGE_ENTRIES)[number];

const GROUP_KEYS = [
  "today",
  "yesterday",
  "previous7Days",
  "previous30Days",
  "earlier",
] as const;

type GroupKey = (typeof GROUP_KEYS)[number];

const DAY_MS = 86_400_000;

function sessionArchived(
  session: SessionSummary,
  meta: SessionMeta | undefined,
): boolean {
  return Boolean(
    meta?.archived || (session as SessionSummary & { archived?: boolean }).archived,
  );
}

function projectBasename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function groupKeyFor(updatedAt: string | undefined, startOfToday: number): GroupKey {
  const ts = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(ts)) return "earlier";
  if (ts >= startOfToday) return "today";
  if (ts >= startOfToday - DAY_MS) return "yesterday";
  if (ts >= startOfToday - 7 * DAY_MS) return "previous7Days";
  if (ts >= startOfToday - 30 * DAY_MS) return "previous30Days";
  return "earlier";
}

function highlightMatch(text: string, query: string) {
  return <SearchHighlight text={text} query={query} />;
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const openProjects = useAppStore((s) => s.openProjects);
  const workspace = useAppStore((s) => s.workspace);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const selectSession = useAppStore((s) => s.selectSession);
  const newSession = useAppStore((s) => s.newSession);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const showToast = useAppStore((s) => s.showToast);
  // Settings search mirrors the rail: developer-only destinations stay out of
  // the result list while developer mode is off.
  const developerMode = useAppStore((s) => s.settings?.developerMode === true);
  const scheduledTasksEnabled = useAppStore((s) => s.settings?.scheduledTasksEnabled !== false);

  const query = useSessionSearchState((state) => state.query);
  const setQuery = useSessionSearchState((state) => state.setQuery);
  const search = useSessionSearch(open, query);
  const selectionRequest = useRef(0);
  useEffect(() => {
    selectionRequest.current += 1;
  }, [open, query]);
  const [active, setActive] = useState(0);
  // The dialog has two sources: conversation messages (existing behaviour) and
  // project file contents, which searches through host-core (#2584 follow-up).
  const [searchTab, setSearchTab] = useState<"sessions" | "files">("sessions");
  // One slot per hit; slots arrive page by page, so a query with 200k hits is
  // still a flat, indexable list for the virtual window below.
  const [fileRows, setFileRows] = useState<(ProjectFileRow | null)[]>([]);
  const [fileFileCount, setFileFileCount] = useState(0);
  // Literal case-insensitive matching is the default; the toggle opts in.
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fileStatus, setFileStatus] = useState<"idle" | "loading" | "error">("idle");
  const fileRoot = workspace?.path ?? "";
  // Files-tab rows open in the bundled file view at the matched line, the same
  // completion chat file references use (ADR 0262).
  const openFileRef = useOpenChatFileRef();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  // Host scans once and serves any offset, so paging asks for the page a visible
  // row belongs to instead of receiving the whole hit set in one frame.
  const fileGeneration = useRef(0);
  const filePagesRef = useRef(new Set<number>());
  const fileQueryRef = useRef("");
  useEffect(() => {
    if (!open || searchTab !== "files") return;
    const trimmed = query.trim();
    // A new query invalidates every page requested for the previous one.
    const generation = ++fileGeneration.current;
    filePagesRef.current = new Set();
    fileQueryRef.current = trimmed;
    if (trimmed.length < 2 || !fileRoot) {
      setFileRows([]);
      setFileFileCount(0);
      setFileStatus("idle");
      return;
    }
    setFileRows([]);
    setFileFileCount(0);
    setFileStatus("loading");
    const timer = window.setTimeout(() => {
      // Claim page 0 up front so the virtual window cannot request it twice
      // while the first page is still in flight.
      filePagesRef.current.add(0);
      api
        .searchProjectText({
          root: fileRoot,
          query: trimmed,
          caseSensitive,
          offset: 0,
          limit: FILE_PAGE_SIZE,
        })
        .then((result) => {
          if (generation !== fileGeneration.current) return;
          const rows: (ProjectFileRow | null)[] = new Array(result.total).fill(null);
          result.matches.forEach((row, index) => {
            rows[index] = row;
          });
          setFileRows(rows);
          setFileFileCount(result.fileCount);
          setFileStatus("idle");
        })
        .catch(() => {
          if (generation !== fileGeneration.current) return;
          filePagesRef.current.delete(0);
          setFileRows([]);
          setFileFileCount(0);
          setFileStatus("error");
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, searchTab, query, fileRoot, caseSensitive]);

  /** Loads every page overlapping `[start, end)` that the dialog does not hold. */
  const ensureFileRange = useCallback(
    (start: number, end: number) => {
      const trimmed = fileQueryRef.current;
      if (!trimmed || !fileRoot) return;
      const generation = fileGeneration.current;
      const firstPage = Math.floor(start / FILE_PAGE_SIZE);
      const lastPage = Math.floor((Math.max(end, start + 1) - 1) / FILE_PAGE_SIZE);
      for (let page = firstPage; page <= lastPage; page += 1) {
        if (filePagesRef.current.has(page)) continue;
        filePagesRef.current.add(page);
        const offset = page * FILE_PAGE_SIZE;
        api
          .searchProjectText({
            root: fileRoot,
            query: trimmed,
            caseSensitive,
            offset,
            limit: FILE_PAGE_SIZE,
          })
          .then((result) => {
            if (generation !== fileGeneration.current) return;
            setFileFileCount(result.fileCount);
            setFileRows((previous) => {
              // The result set changed under us: drop this page rather than
              // write rows at offsets that now mean something else.
              if (previous.length !== result.total) return previous;
              const next = previous.slice();
              result.matches.forEach((row, index) => {
                const at = offset + index;
                if (at < next.length) next[at] = row;
              });
              return next;
            });
          })
          .catch(() => {
            if (generation !== fileGeneration.current) return;
            filePagesRef.current.delete(page);
          });
      }
    },
    [fileRoot, caseSensitive],
  );
  const [commandResult, setCommandResult] = useState<{
    query: string;
    hits: CommandItem[];
  }>({ query: "", hits: [] });
  const commandHits = commandResult.query === query ? commandResult.hits : [];

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setCommandResult((result) => ({ ...result, hits: [] }));
    // Catch sessions renamed/created since the last store refresh.
    void refreshSessions().catch(() => undefined);
  }, [open, refreshSessions]);

  // Surface command-palette commands inside global search so a single
  // surface covers sessions, pages, settings, and commands.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void api
        .searchCommands(query)
        .then((res) => {
          if (!cancelled) setCommandResult({ query, hits: res.commands });
        })
        .catch(() => {
          if (!cancelled) setCommandResult({ query, hits: [] });
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, open]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of openProjects) {
      const key = normalizeProjectPath(project.path);
      if (key && project.name?.trim()) names.set(key, project.name.trim());
    }
    const wsKey = normalizeProjectPath(workspace?.path);
    if (wsKey && workspace?.name?.trim() && !names.has(wsKey)) {
      names.set(wsKey, workspace.name.trim());
    }
    return names;
  }, [openProjects, workspace]);

  const rows = useMemo<SearchRow[]>(() => {
    const q = query.trim().toLowerCase();
    const candidates: Omit<SearchRow, "optionIndex">[] = [];
    // Recents come from the store, so the same ownership rule applies here:
    // a scheduled run's transcript is entered from the Scheduled page, never
    // offered as a conversation to switch to (issue #1291).
    const source = listableSessions(q ? search.hits.map((hit) => hit.session) : sessions);
    const hits = new Map(search.hits.map((hit) => [hit.session.id, hit]));
    for (const session of source) {
      // Untitled drafts carry no searchable signal; they stay sidebar-only.
      if (!q && isDefaultSessionTitle(session.title)) continue;
      const archived = sessionArchived(session, sessionMeta[session.id]);
      // Recents view keeps the sidebar's default: archived stays hidden
      // until the user actually searches for it.
      if (archived && !q) continue;
      const projectKey = normalizeProjectPath(session.projectPath);
      const hit = q ? hits.get(session.id) : undefined;
      const projectLabel =
        hit?.projectName ||
        (projectKey
          ? (projectNames.get(projectKey) ?? projectBasename(projectKey))
          : t("nav.temporarySessions"));
      candidates.push({ session, archived, projectLabel, hit });
    }
    candidates.sort((a, b) => {
      const aTs = Date.parse(a.session.updatedAt || "") || 0;
      const bTs = Date.parse(b.session.updatedAt || "") || 0;
      return bTs - aTs || a.session.id.localeCompare(b.session.id);
    });
    let index = 1;
    return (q ? candidates : candidates.slice(0, 30)).map((row) => {
      const optionIndex = index;
      index += 1 + (row.hit?.matches.length ?? 0);
      return { ...row, optionIndex };
    });
  }, [sessions, sessionMeta, projectNames, query, search.hits, t]);

  const groups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const byKey = new Map<GroupKey, SearchRow[]>();
    for (const row of rows) {
      const key = groupKeyFor(row.session.updatedAt, startOfToday);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }
    return GROUP_KEYS.filter((key) => byKey.has(key)).map((key) => ({
      key,
      rows: byKey.get(key)!,
    }));
  }, [rows]);

  // Pages and settings rows join the listbox after the session results;
  // flat option order is: new-task, sessions, pages, settings.
  const pageHits = useMemo<PageEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return PAGE_ENTRIES.filter((entry) =>
      (entry.page !== "scheduled" || scheduledTasksEnabled) &&
      t(entry.labelKey).toLowerCase().includes(q));
  }, [query, t, scheduledTasksEnabled]);

  const settingsHits = useMemo<SettingsSearchHit[]>(
    () =>
      searchSettings(query, t, {
        developerMode,
        includeDevelopmentOnly: import.meta.env.DEV,
      }),
    [query, t, developerMode],
  );

  const sessionOptionCount = rows.reduce(
    (count, row) => count + 1 + (row.hit?.matches.length ?? 0),
    0,
  );
  const moreIndex = sessionOptionCount + 1;
  const pageBase = moreIndex + (query.trim() && search.nextOffset !== null ? 1 : 0);
  const settingsBase = pageBase + pageHits.length;
  const commandsBase = settingsBase + settingsHits.length;
  // The Files tab owns its own listbox, so keyboard indices must address the
  // file rows instead of the session rows that stay mounted but hidden.
  const optionCount =
    searchTab === "files" ? fileRows.length : commandsBase + commandHits.length;

  useEffect(() => {
    setActive(0);
  }, [query, searchTab]);

  useEffect(() => {
    setActive((value) => Math.min(value, optionCount - 1));
  }, [optionCount]);

  useEffect(() => {
    // The Files list scrolls its own virtual window, so it keeps the active row
    // in view itself; this only serves the shared session/page/settings list.
    if (!open || searchTab === "files") return;
    document
      .getElementById(`global-search-option-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, searchTab]);

  if (!open) return null;

  const run = async (row: SearchRow | null, messageId?: string) => {
    const request = ++selectionRequest.current;
    try {
      if (row) {
        const current = useAppStore.getState();
        if (current.activeSessionId === row.session.id && !current.selectingSessionId)
          current.setPage("chat");
        else await selectSession(row.session.id);
        const selected = useAppStore.getState();
        if (
          request !== selectionRequest.current ||
          selected.activeSessionId !== row.session.id ||
          selected.page !== "chat"
        )
          return;
        const targetId = messageId ?? row.hit?.matches[0]?.messageId;
        if (targetId) void selected.navigateTranscript({
          sessionId: row.session.id, messageId: targetId, query: query.trim(),
        });
      } else await newSession();
      onClose();
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus({ preventScroll: true });
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const openSettingsHit = (hit: SettingsSearchHit) => {
    setSettingsAnchor(hit.rowKey);
    setSettingsTab(hit.tab);
    onClose();
  };

  const openPage = (entry: PageEntry) => {
    setPage(entry.page);
    onClose();
  };

  const runCommand = async (command: CommandItem) => {
    try {
      await runPaletteCommand(command.id);
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  /** Tab moves focus, so the dialog switches source itself and keeps focus. */
  const switchTab = (next: "sessions" | "files") => {
    if (next === searchTab) return;
    if (next === "files" && !fileRoot) return;
    setSearchTab(next);
    setActive(0);
  };

  const openFileRow = (row: ProjectFileRow) => {
    const position = { line: row.line, column: row.column };
    // Chat file references resolve through the active session. A project with no
    // conversation yet has nothing to resolve against, so the row still opens
    // the file view directly instead of silently doing nothing.
    if (activeSessionId) {
      openFileRef(row.path, undefined, undefined, position);
    } else {
      // The work panel is session-scoped, so there is no file view to open yet.
      showToast(t("search.filesNeedChat"), { variant: "error" });
    }
    onClose();
  };

  const runActive = () => {
    if (searchTab === "files") {
      const row = fileRows[active];
      // A row outside the loaded pages opens once its page lands.
      if (!row) {
        ensureFileRange(active, active + 1);
        return;
      }
      openFileRow(row);
      return;
    }
    if (active === 0) return void run(null);
    for (const row of rows) {
      if (active === row.optionIndex) return void run(row);
      const match = row.hit?.matches[active - row.optionIndex - 1];
      if (match) return void run(row, match.messageId);
    }
    if (active === moreIndex && search.nextOffset !== null) return search.loadMore();
    const pageIndex = active - pageBase;
    if (pageIndex >= 0 && pageIndex < pageHits.length)
      return openPage(pageHits[pageIndex]);
    const settingsIndex = active - settingsBase;
    if (settingsIndex >= 0 && settingsIndex < settingsHits.length) {
      return openSettingsHit(settingsHits[settingsIndex]);
    }
    const commandIndex = active - commandsBase;
    if (commandIndex >= 0 && commandIndex < commandHits.length) {
      return void runCommand(commandHits[commandIndex]);
    }
  };

  return (
    <OverlayBackdrop className="search-overlay" onClick={onClose}>
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.search")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          // Escape must close even when focus left the input (e.g. tabbing).
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="search-input-row">
          <IconSearch size={16} aria-hidden />
          <input
            className="search-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="global-search-results"
            aria-activedescendant={`global-search-option-${active}`}
            aria-label={t("nav.search")}
            placeholder={t(
              searchTab === "files" ? "search.placeholderFiles" : "search.placeholder",
            )}
            value={query}
            maxLength={500}
            autoFocus
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, optionCount - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              }
              if (event.key === "Tab") {
                event.preventDefault();
                switchTab(searchTab === "sessions" ? "files" : "sessions");
              }
              if (event.key === "Enter") {
                event.preventDefault();
                runActive();
              }
            }}
          />
          <div className="search-tabs" role="tablist" aria-label={t("nav.search")}>
            <button
              type="button"
              role="tab"
              aria-selected={searchTab === "sessions"}
              className={`search-tab ${searchTab === "sessions" ? "active" : ""}`}
              onClick={() => {
                setSearchTab("sessions");
                setActive(0);
              }}
            >
              {t("search.tabSessions")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={searchTab === "files"}
              className={`search-tab ${searchTab === "files" ? "active" : ""}`}
              disabled={!fileRoot}
              title={fileRoot ? fileRoot : t("search.filesNoProject")}
              onClick={() => {
                setSearchTab("files");
                setActive(0);
              }}
            >
              {t("search.tabFiles")}
            </button>
          </div>
        </div>
        <div
          id="global-search-results"
          className={`search-results${searchTab === "files" ? " is-files-tab" : ""}`}
          role="listbox"
          aria-label={t("nav.search")}
        >
          {searchTab === "files" ? (
            <>
              <ProjectFileSearchResults
                rows={fileRows}
                fileCount={fileFileCount}
                query={query}
                active={active}
                caseSensitive={caseSensitive}
                onToggleCase={() => {
                  setCaseSensitive((value) => !value);
                  setActive(0);
                }}
                onActivate={setActive}
                onSelect={openFileRow}
                onEnsureRange={ensureFileRange}
              />
              {fileStatus === "loading" ? (
                <div className="search-empty" role="status">
                  {t("search.loading")}
                </div>
              ) : null}
              {fileStatus === "error" ? (
                <div className="search-empty" role="alert">
                  {t("search.failed")}
                </div>
              ) : null}
              {fileStatus === "idle" && query.trim().length >= 2 && fileRows.length === 0 ? (
                <div className="search-empty">{t("search.filesEmpty")}</div>
              ) : null}
            </>
          ) : null}
          <button
            id="global-search-option-0"
            type="button"
            role="option"
            aria-selected={active === 0}
            className={`search-item ${active === 0 ? "active" : ""}`}
            onMouseEnter={() => setActive(0)}
            onClick={() => void run(null)}
          >
            <IconNewSession size={15} className="search-item-icon" />
            <span className="search-item-title">{t("nav.newTask")}</span>
          </button>
          <SearchSessionResults
            groups={groups}
            query={query}
            active={active}
            runningSessions={runningSessions}
            onActivate={setActive}
            onSelect={(row, messageId) => void run(row, messageId)}
          />
          {query.trim() && search.loading ? (
            <div className="search-empty" role="status">
              {t("search.loading")}
            </div>
          ) : null}
          {query.trim() && search.error ? (
            <div className="search-empty" role="alert">
              {t("search.failed")}
              <button type="button" className="btn btn-secondary" onClick={search.retry}>
                {t("search.retry")}
              </button>
            </div>
          ) : null}
          {query.trim() && search.nextOffset !== null ? (
            <button
              id={`global-search-option-${moreIndex}`}
              type="button"
              role="option"
              aria-selected={active === moreIndex}
              aria-disabled={search.loading}
              className={`search-item ${active === moreIndex ? "active" : ""}`}
              onMouseEnter={() => setActive(moreIndex)}
              onClick={search.loadMore}
            >
              {t("search.loadMore")}
            </button>
          ) : null}
          {pageHits.length > 0 ? (
            <div role="presentation">
              <div className="search-group-label" role="presentation">
                {t("search.pages")}
              </div>
              {pageHits.map((entry, index) => {
                const optionIndex = pageBase + index;
                const Icon = entry.icon;
                return (
                  <button
                    key={entry.page}
                    id={`global-search-option-${optionIndex}`}
                    type="button"
                    role="option"
                    aria-selected={active === optionIndex}
                    className={`search-item ${active === optionIndex ? "active" : ""}`}
                    onMouseEnter={() => setActive(optionIndex)}
                    onClick={() => openPage(entry)}
                  >
                    <Icon size={15} className="search-item-icon" />
                    <span className="search-item-title">
                      {highlightMatch(t(entry.labelKey), query)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {settingsHits.length > 0 ? (
            <div role="presentation">
              <div className="search-group-label" role="presentation">
                {t("nav.settings")}
              </div>
              {settingsHits.map((hit, index) => {
                const optionIndex = settingsBase + index;
                return (
                  <button
                    key={`${hit.tab}:${hit.rowKey ?? "tab"}`}
                    id={`global-search-option-${optionIndex}`}
                    type="button"
                    role="option"
                    aria-selected={active === optionIndex}
                    className={`search-item ${active === optionIndex ? "active" : ""}`}
                    onMouseEnter={() => setActive(optionIndex)}
                    onClick={() => openSettingsHit(hit)}
                  >
                    <IconSettings size={15} className="search-item-icon" />
                    <span className="search-item-title">
                      {highlightMatch(t(hit.rowKey ?? hit.tabLabelKey), query)}
                    </span>
                    {hit.rowKey ? (
                      <span className="search-item-meta">
                        <span className="search-item-project">{t(hit.tabLabelKey)}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {commandHits.length > 0 ? (
            <div role="presentation">
              <div className="search-group-label" role="presentation">
                {t("search.commands")}
              </div>
              {commandHits.map((command, index) => {
                const optionIndex = commandsBase + index;
                return (
                  <button
                    key={command.id}
                    id={`global-search-option-${optionIndex}`}
                    type="button"
                    role="option"
                    aria-selected={active === optionIndex}
                    className={`search-item ${active === optionIndex ? "active" : ""}`}
                    onMouseEnter={() => setActive(optionIndex)}
                    onClick={() => void runCommand(command)}
                  >
                    <IconSliders size={15} className="search-item-icon" />
                    <span className="search-item-title">
                      {highlightMatch(command.title, query)}
                    </span>
                    {command.source === "plugin" && (
                      <span className="search-item-badge">{t("plugins.title")}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
          {rows.length === 0 &&
          pageHits.length === 0 &&
          settingsHits.length === 0 &&
          commandHits.length === 0 &&
          query.trim() &&
          !search.loading &&
          !search.error ? (
            <div className="search-empty">{t("search.empty")}</div>
          ) : null}
        </div>
      </div>
    </OverlayBackdrop>
  );
}
