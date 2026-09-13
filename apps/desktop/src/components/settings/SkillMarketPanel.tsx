import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_SKILL_CATALOG,
  GLOBAL_SCOPE,
  isSafeSkillSourceUrl,
  mergeSkillEntries,
  sanitizeSkillSources,
  validateSkillCatalogFile,
  type SkillCatalogCategory,
  type SkillCatalogEntry,
  type SkillMarketSource,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  IconBookOpen,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconDatabase,
  IconFileText,
  IconListChecks,
  IconX,
} from "../icons";
import { Field, Input, TooltipButton, cx } from "../ui";

const CATEGORIES: readonly SkillCatalogCategory[] = [
  "workflow",
  "writing",
  "coding",
  "data",
  "docs",
];

/** Cards render in a scrolling settings pane, so the list is paginated. */
const PAGE_SIZE = 24;

const { skills } = validateSkillCatalogFile(BUILTIN_SKILL_CATALOG).catalog;

const CATEGORY_ICONS: Record<SkillCatalogCategory, typeof IconListChecks> = {
  workflow: IconListChecks,
  writing: IconFileText,
  coding: IconCode,
  data: IconDatabase,
  docs: IconBookOpen,
};

function CategoryGlyph({ entry, size }: { entry: SkillCatalogEntry; size: number }) {
  const category = entry.categories?.[0];
  const Icon = (category && CATEGORY_ICONS[category]) || IconFileText;
  return <Icon size={size} />;
}

type MarketItem = SkillCatalogEntry & { sourceId?: string };

type RemoteState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: MarketItem[];
  failed: string[];
};

const REMOTE_IDLE: RemoteState = { status: "idle", entries: [], failed: [] };

const SOURCES_STORAGE_KEY = "pi.skill-market.sources.v1";

function loadSources(): SkillMarketSource[] {
  try {
    const raw = window.localStorage?.getItem(SOURCES_STORAGE_KEY);
    return raw ? sanitizeSkillSources(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

const DEFAULT_SKILL_SOURCES: SkillMarketSource[] = [
  // Auto-scanned: every SKILL.md on the default branch becomes installable.
  { id: "anthropics-skills", name: "anthropics/skills", url: "https://github.com/anthropics/skills" },
];

function saveSources(sources: SkillMarketSource[]): void {
  try {
    window.localStorage?.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
  } catch {
    // Persistence is best-effort; the list stays alive for this session.
  }
}

/**
 * The market view of the skills settings page: browse catalog sources, install
 * with one click. An install only ever produces a regular user skill through
 * the existing create path, and the full document is previewed before
 * anything is saved.
 */
export function SkillMarketPanel({
  installedIds,
  onBack,
  onInstalled,
}: {
  installedIds: readonly string[];
  onBack: () => void;
  onInstalled: (id: string) => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | SkillCatalogCategory>("all");
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState("");
  const [installFor, setInstallFor] = useState<MarketItem | null>(null);
  const [documentBody, setDocumentBody] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [sources, setSources] = useState<SkillMarketSource[]>(loadSources);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [draftSource, setDraftSource] = useState<{ name: string; url: string }>({
    name: "",
    url: "",
  });
  const [remote, setRemote] = useState<RemoteState>(REMOTE_IDLE);

  useEffect(() => {
    saveSources(sources);
  }, [sources]);

  // Catalog sources are searched live (debounced); built-in picks render
  // immediately and stay as the offline floor when all sources are down.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setRemote((current) =>
        current.status === "idle" || current.status === "ready"
          ? { status: "loading", entries: current.entries, failed: current.failed }
          : current,
      );
      api
        .searchSkillMarket(search, [...DEFAULT_SKILL_SOURCES, ...sources])
        .then((result) => {
          if (!cancelled) {
            const failed = result.failedSources ?? [];
            const entries = result.entries ?? [];
            setRemote({
              status: entries.length === 0 && failed.length > 0 ? "error" : "ready",
              entries,
              failed,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setRemote({ status: "error", entries: [], failed: [] });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, sources]);

  const sourceName = (id?: string) =>
    id ? sources.find((source) => source.id === id)?.name : undefined;

  const remoteIds = useMemo(
    () => new Set(remote.entries.map((entry) => entry.id)),
    [remote.entries],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = (entry: SkillCatalogEntry) => {
      if (category !== "all" && !(entry.categories ?? []).includes(category)) return false;
      if (!query) return true;
      return [entry.name, entry.description, entry.author]
        .filter(Boolean)
        .some((text) => text!.toLocaleLowerCase().includes(query));
    };
    return mergeSkillEntries(
      skills.filter(matches),
      remote.entries.filter(matches),
    ) as MarketItem[];
  }, [remote.entries, search, category]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visible, currentPage],
  );

  const openInstall = (entry: MarketItem) => {
    setInstallFor(entry);
    setDocumentBody(null);
    api
      .fetchSkillMarketDocument(entry)
      .then((document) => setDocumentBody(document.body))
      .catch(() => setDocumentBody(null));
  };

  const install = async () => {
    if (!installFor || installing) return;
    setInstalling(true);
    try {
      const document = await api.fetchSkillMarketDocument(installFor);
      await api.createUserSkill({
        id: installFor.id,
        name: document.name || installFor.name,
        description: document.description || installFor.description,
        body: document.body,
        level: "global",
        scope: GLOBAL_SCOPE,
        enabled: true,
      });
      showToast(t("settings.sklm.installSuccess", { name: installFor.name }), {
        variant: "success",
      });
      onInstalled(installFor.id);
      setInstallFor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setInstalling(false);
    }
  };

  const removeSource = (id: string) =>
    setSources((current) => current.filter((source) => source.id !== id));

  const addSource = () => {
    const url = draftSource.url.trim();
    if (!isSafeSkillSourceUrl(url)) {
      showToast(t("settings.sklm.sourceUnsafe"), { variant: "error" });
      return;
    }
    const fallbackName = url.replace(/^https:\/\//, "").split("/")[0] || url;
    setSources((current) => [
      ...current,
      { id: `custom-${Date.now().toString(36)}`, name: draftSource.name.trim() || fallbackName, url },
    ]);
    setDraftSource({ name: "", url: "" });
  };

  const sourcesSheet = sourcesOpen ? (
    <div
      className="overlay ext-sheet-overlay sklm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSourcesOpen(false);
      }}
    >
      <div
        className="dialog ext-sheet sklm-sheet"
        role="dialog"
        aria-modal
        aria-labelledby="sklm-sources-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="sklm-sources-title" className="ext-sheet-title">
              {t("settings.sklm.manageSources")}
            </h3>
            <p className="ext-sheet-sub">{t("settings.sklm.sourcesHint")}</p>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => setSourcesOpen(false)}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <ul className="sklm-source-list">
            <li className="sklm-source">
              <span className="sklm-glyph is-docs" aria-hidden>
                <IconBookOpen size={16} />
              </span>
              <div className="sklm-source-body">
                <span className="sklm-name">{t("settings.sklm.builtinSource")}</span>
                <code className="sklm-cmd">{t("settings.sklm.builtinHint")}</code>
              </div>
              <span className="sklm-badge is-verified">✓</span>
            </li>
            <li className="sklm-source">
              <span className="sklm-glyph is-coding" aria-hidden>
                <IconCode size={16} />
              </span>
              <div className="sklm-source-body">
                <span className="sklm-name">anthropics/skills</span>
                <code className="sklm-cmd">https://github.com/anthropics/skills</code>
              </div>
              <span className="sklm-badge">GitHub</span>
            </li>
            {sources.map((source) => (
              <li key={source.id} className="sklm-source">
                <span className="sklm-glyph is-docs" aria-hidden>
                  <IconBookOpen size={16} />
                </span>
                <div className="sklm-source-body">
                  <span className="sklm-name">{source.name}</span>
                  <code className="sklm-cmd">{source.url}</code>
                </div>
                <button
                  type="button"
                  className="sklm-install is-ghost"
                  onClick={() => removeSource(source.id)}
                >
                  {t("extensions.mcp.remove")}
                </button>
              </li>
            ))}
          </ul>

          <div className="sklm-source-form">
            <Input
              value={draftSource.name}
              placeholder={t("settings.sklm.namePlaceholder")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, name: event.target.value }))
              }
            />
            <Input
              value={draftSource.url}
              placeholder={t("settings.sklm.urlHint")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, url: event.target.value }))
              }
            />
            <button type="button" className="sklm-install" onClick={addSource}>
              {t("settings.sklm.addSource")}
            </button>
          </div>
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.sklm.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="sklm-install is-ghost"
              onClick={() => setSourcesOpen(false)}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const installSheet = installFor ? (
    <div
      className="overlay ext-sheet-overlay sklm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !installing) setInstallFor(null);
      }}
    >
      <div className="dialog ext-sheet sklm-sheet" role="dialog" aria-modal aria-labelledby="sklm-sheet-title">
        <div className="ext-sheet-head">
          <div className="sklm-sheet-head">
            <span
              className={cx("sklm-glyph", `is-${installFor.categories?.[0] ?? "docs"}`)}
              aria-hidden
            >
              <CategoryGlyph entry={installFor} size={18} />
            </span>
            <div>
              <h3 id="sklm-sheet-title" className="ext-sheet-title">
                {installFor.name}
              </h3>
              <p className="ext-sheet-sub">{installFor.description}</p>
            </div>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => setInstallFor(null)}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <div className="ext-field-group">
            <div className="ext-field-label">{t("settings.sklm.willInstall")}</div>
            <code className="sklm-cmd is-block">{installFor.url}</code>
          </div>

          <div className="ext-field-group">
            <div className="ext-field-label">{t("settings.sklm.preview")}</div>
            <pre className="sklm-preview">{documentBody ?? t("common.loading")}</pre>
          </div>

          {installFor.notes ? (
            <p className="sklm-note">
              <span className="sklm-note-label">{t("settings.sklm.notes")}</span>
              {installFor.notes}
            </p>
          ) : null}
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.sklm.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="sklm-install is-ghost"
              onClick={() => setInstallFor(null)}
              disabled={installing}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="sklm-install"
              onClick={() => void install()}
              disabled={installing || documentBody === null}
            >
              {installing ? t("common.saving") : t("settings.sklm.install")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="sklm">
      <div className="sklm-head">
        <div className="sklm-head-copy">
          <button type="button" className="sklm-back" onClick={onBack}>
            <IconChevronLeft size={14} />
            {t("settings.sklm.back")}
          </button>
          <h3 className="sklm-title">{t("settings.sklm.title")}</h3>
          <p className="sklm-subtitle">{t("settings.sklm.subtitle")}</p>
        </div>
        <div className="sklm-head-actions">
          <button type="button" className="sklm-back" onClick={() => setSourcesOpen(true)}>
            {t("settings.sklm.manageSources")} · {sources.length}
          </button>
        </div>
        <div className="sklm-search">
          <Input
            className="sklm-search-input"
            value={search}
            placeholder={t("settings.sklm.searchPlaceholder")}
            aria-label={t("settings.sklm.searchPlaceholder")}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {remote.status === "loading" ? (
        <p className="sklm-status" role="status">
          {t("settings.sklm.remoteLoading")}
        </p>
      ) : null}
      {remote.status === "error" ? (
        <p className="sklm-status is-error" role="status">
          {t("settings.sklm.remoteError")}
          {remote.failed.length ? ` (${remote.failed.join(", ")})` : ""}
        </p>
      ) : null}

      <div className="sklm-cats" role="tablist" aria-label={t("settings.sklm.title")}>
        {(["all", ...CATEGORIES] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            className={cx("sklm-chip", category === id && "is-active")}
            onClick={() => {
              setCategory(id);
              setPage(1);
            }}
          >
            {id === "all"
              ? t("settings.sklm.categoryAll")
              : t(`settings.sklm.category.${id}`)}
          </button>
        ))}
      </div>

      <div className="sklm-list" role="list">
        {paged.length === 0 ? (
          <p className="sklm-empty">{t("settings.sklm.empty")}</p>
        ) : (
          paged.map((entry, index) => {
            const installed = installedIds.includes(entry.id);
            return (
              <article
                key={entry.id}
                role="listitem"
                className="sklm-card"
                style={{ "--stagger": Math.min(index, 8) } as CSSProperties}
              >
                <span
                  className={cx("sklm-glyph", `is-${entry.categories?.[0] ?? "docs"}`)}
                  aria-hidden
                >
                  <CategoryGlyph entry={entry} size={17} />
                </span>
                <div className="sklm-card-body">
                  <div className="sklm-card-title">
                    <span className="sklm-name">{entry.name}</span>
                    {entry.verified ? (
                      <span className="sklm-badge is-verified">
                        ✓ {t("settings.sklm.verified")}
                      </span>
                    ) : null}
                    {remoteIds.has(entry.id) ? (
                      <span className="sklm-badge is-remote">
                        {sourceName(entry.sourceId) ?? t("settings.sklm.remoteBadge")}
                      </span>
                    ) : null}
                    {(entry.categories ?? []).slice(0, 1).map((id) => (
                      <span key={id} className="sklm-badge">
                        {t(`settings.sklm.category.${id}`)}
                      </span>
                    ))}
                  </div>
                  <code className="sklm-cmd">{entry.author ?? entry.id}</code>
                  <p className="sklm-desc">{entry.description || ""}</p>
                </div>
                <div className="sklm-card-actions">
                  <button
                    type="button"
                    className={cx("sklm-install", installed && "is-installed")}
                    disabled={installed}
                    title={entry.homepage}
                    onClick={() => openInstall(entry)}
                  >
                    {installed
                      ? t("settings.sklm.installed")
                      : t("settings.sklm.install")}
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {totalPages > 1 ? (
        <div className="sklm-pager">
          <button
            type="button"
            className="sklm-page-btn"
            disabled={currentPage <= 1}
            aria-label={t("settings.sklm.pagePrev")}
            onClick={() => setPage(currentPage - 1)}
          >
            <IconChevronLeft size={14} />
          </button>

          {(() => {
            const wanted = new Set<number>([1, 2, totalPages, totalPages - 1]);
            for (let p = currentPage - 2; p <= currentPage + 2; p += 1) {
              if (p >= 1 && p <= totalPages) wanted.add(p);
            }
            const ordered = [...wanted].sort((a, b) => a - b);
            const items: Array<number | "…"> = [];
            let previous = 0;
            for (const p of ordered) {
              if (p - previous > 1) items.push("…");
              items.push(p);
              previous = p;
            }
            return items.map((item, index) =>
              item === "…" ? (
                <span key={`gap-${index}`} className="sklm-page-ellipsis">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={cx("sklm-page-btn", item === currentPage && "is-active")}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ),
            );
          })()}

          <span className="sklm-page-info">
            {t("settings.sklm.pageInfo", {
              page: currentPage,
              pages: totalPages,
              total: visible.length,
            })}
          </span>

          <input
            className="sklm-page-jump field-input"
            type="text"
            inputMode="numeric"
            value={jump}
            placeholder={String(currentPage)}
            aria-label={t("settings.sklm.pageJump")}
            onChange={(event) => setJump(event.target.value.replace(/\D/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") doJump();
            }}
          />
          <button
            type="button"
            className="sklm-page-btn"
            disabled={currentPage >= totalPages}
            aria-label={t("settings.sklm.pageNext")}
            onClick={() => setPage(currentPage + 1)}
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      ) : null}

      {/* The settings shell carries a transform, which would turn the
          overlay's `position: fixed` into shell-relative positioning — portal
          both sheets to <body> so they always cover the window. */}
      {installSheet && createPortal(installSheet, document.body)}
      {sourcesSheet && createPortal(sourcesSheet, document.body)}
    </div>
  );

  function doJump() {
    const target = Number.parseInt(jump, 10);
    if (Number.isNaN(target)) {
      setJump("");
      return;
    }
    setPage(Math.min(totalPages, Math.max(1, target)));
    setJump("");
  }
}
