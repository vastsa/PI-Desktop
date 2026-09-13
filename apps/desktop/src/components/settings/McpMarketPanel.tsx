import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_MCP_CATALOG,
  DEFAULT_MARKET_SOURCE,
  GLOBAL_SCOPE,
  isSafeMarketSourceUrl,
  mergeRegistryEntries,
  resolveCatalogEntry,
  sanitizeMarketSources,
  validateMcpCatalogFile,
  type MarketSource,
  type McpCatalogCategory,
  type McpCatalogEntry,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconChevronLeft, IconServer, IconTerminal, IconX } from "../icons";
import { Field, Input, TooltipButton, cx } from "../ui";

const CATEGORIES: readonly McpCatalogCategory[] = [
  "devtools",
  "web",
  "docs",
  "data",
  "productivity",
];

const { servers } = validateMcpCatalogFile(BUILTIN_MCP_CATALOG).catalog;

type RemoteState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: McpCatalogEntry[];
  failed: string[];
};

const REMOTE_IDLE: RemoteState = { status: "idle", entries: [], failed: [] };

type MarketItem = McpCatalogEntry & { sourceId?: string };

const SOURCES_STORAGE_KEY = "pi.mcp-market.sources.v1";

function loadSources(): MarketSource[] {
  try {
    const raw = window.localStorage?.getItem(SOURCES_STORAGE_KEY);
    return raw ? sanitizeMarketSources(JSON.parse(raw)) : [DEFAULT_MARKET_SOURCE];
  } catch {
    return [DEFAULT_MARKET_SOURCE];
  }
}

function saveSources(sources: MarketSource[]): void {
  try {
    window.localStorage?.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
  } catch {
    // Persistence is best-effort; the list stays alive for this session.
  }
}

/**
 * The market view of the MCP settings page: browse the builtin catalog,
 * install with one click. An install only ever produces a regular user
 * server through the existing upsert path — the panel adds no write path
 * of its own, and the exact command is on screen before anything is saved.
 */
export function McpMarketPanel({
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
  const [category, setCategory] = useState<"all" | McpCatalogCategory>("all");
  const [installFor, setInstallFor] = useState<McpCatalogEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<RemoteState>(REMOTE_IDLE);
  const [sources, setSources] = useState<MarketSource[]>(loadSources);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [draftSource, setDraftSource] = useState<{
    name: string;
    url: string;
    kind: MarketSource["kind"];
  }>({ name: "", url: "", kind: "registry" });

  useEffect(() => {
    saveSources(sources);
  }, [sources]);

  // Every configured source is queried live (debounced); built-in picks render
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
        .searchMcpMarketRegistry(search, sources)
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
    const matches = (entry: McpCatalogEntry) => {
      if (category !== "all" && !(entry.categories ?? []).includes(category)) return false;
      if (!query) return true;
      return [entry.name, entry.description, entry.author]
        .filter(Boolean)
        .some((text) => text!.toLocaleLowerCase().includes(query));
    };
    return mergeRegistryEntries(
      servers.filter(matches),
      remote.entries.filter(matches),
    ) as MarketItem[];
  }, [remote.entries, search, category]);

  const openInstall = (entry: McpCatalogEntry) => {
    const prefilled: Record<string, string> = {};
    for (const spec of entry.requiredEnv ?? []) {
      if (spec.defaultValue) prefilled[spec.name] = spec.defaultValue;
    }
    setValues(prefilled);
    setInstallFor(entry);
  };

  const install = async () => {
    if (!installFor || saving) return;
    setSaving(true);
    try {
      const input = resolveCatalogEntry(installFor, values);
      await api.upsertMcpServer({ ...input, level: "global", scope: GLOBAL_SCOPE });
      showToast(t("settings.mcpMarket.installSuccess", { name: installFor.name }), {
        variant: "success",
      });
      onInstalled(installFor.id);
      setInstallFor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const installSheet = installFor ? (
    <div
      className="overlay ext-sheet-overlay mcpm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) setInstallFor(null);
      }}
    >
      <div className="dialog ext-sheet mcpm-sheet" role="dialog" aria-modal aria-labelledby="mcpm-sheet-title">
        <div className="ext-sheet-head">
          <div className="mcpm-sheet-head">
            <span
              className={cx(
                "mcpm-glyph",
                `is-${installFor.categories?.[0] ?? "devtools"}`,
              )}
              aria-hidden
            >
              {installFor.transport === "http" ? (
                <IconServer size={18} />
              ) : (
                <IconTerminal size={18} />
              )}
            </span>
            <div>
              <h3 id="mcpm-sheet-title" className="ext-sheet-title">
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
            <div className="ext-field-label">{t("settings.mcpMarket.willRun")}</div>
            <code className="mcpm-cmd is-block">
              {installFor.transport === "http"
                ? installFor.url
                : [installFor.command, ...(installFor.args ?? [])].join(" ")}
            </code>
          </div>

          {installFor.prerequisites?.length ? (
            <p className="mcpm-note">
              <span className="mcpm-note-label">{t("settings.mcpMarket.prerequisites")}</span>
              {installFor.prerequisites.join("；")}
            </p>
          ) : null}
          {installFor.notes ? (
            <p className="mcpm-note">
              <span className="mcpm-note-label">{t("settings.mcpMarket.notes")}</span>
              {installFor.notes}
            </p>
          ) : null}

          {installFor.requiredEnv?.length ? (
            <div className="ext-field-group">
              <div className="ext-field-label">{t("settings.mcpMarket.requiredValues")}</div>
              {installFor.requiredEnv.map((spec) => (
                <Field
                  key={spec.name}
                  label={spec.name}
                  hint={
                    spec.description
                      ? `${spec.description}${spec.optional ? `（${t("settings.mcpMarket.optionalHint")}）` : ""}`
                      : spec.optional
                        ? t("settings.mcpMarket.optionalHint")
                        : undefined
                  }
                >
                  <Input
                    value={values[spec.name] ?? ""}
                    type="password"
                    autoComplete="off"
                    placeholder={spec.defaultValue || spec.name}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [spec.name]: event.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
          ) : null}
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.mcpMarket.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="mcpm-install is-ghost"
              onClick={() => setInstallFor(null)}
              disabled={saving}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mcpm-install"
              onClick={() => void install()}
              disabled={saving}
            >
              {saving ? t("common.saving") : t("settings.mcpMarket.install")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const removeSource = (id: string) =>
    setSources((current) => current.filter((source) => source.id !== id));

  const addSource = () => {
    const url = draftSource.url.trim();
    if (!isSafeMarketSourceUrl(url)) {
      showToast(t("settings.mcpMarket.sourceUnsafe"), { variant: "error" });
      return;
    }
    const fallbackName = url.replace(/^https:\/\//, "").split("/")[0] || url;
    setSources((current) => [
      ...current,
      {
        id: `custom-${Date.now().toString(36)}`,
        name: draftSource.name.trim() || fallbackName,
        url,
        kind: draftSource.kind,
      },
    ]);
    setDraftSource({ name: "", url: "", kind: "registry" });
  };

  const sourcesSheet = sourcesOpen ? (
    <div
      className="overlay ext-sheet-overlay mcpm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSourcesOpen(false);
      }}
    >
      <div
        className="dialog ext-sheet mcpm-sheet"
        role="dialog"
        aria-modal
        aria-labelledby="mcpm-sources-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="mcpm-sources-title" className="ext-sheet-title">
              {t("settings.mcpMarket.manageSources")}
            </h3>
            <p className="ext-sheet-sub">{t("settings.mcpMarket.sourcesHint")}</p>
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
          <ul className="mcpm-source-list">
            {sources.map((source) => (
              <li key={source.id} className="mcpm-source">
                <span
                  className={cx(
                    "mcpm-glyph",
                    source.kind === "registry" ? "is-devtools" : "is-docs",
                  )}
                  aria-hidden
                >
                  {source.kind === "registry" ? <IconServer size={16} /> : <IconTerminal size={16} />}
                </span>
                <div className="mcpm-source-body">
                  <span className="mcpm-name">
                    {source.id === DEFAULT_MARKET_SOURCE.id
                      ? t("settings.mcpMarket.officialSource")
                      : source.name}
                  </span>
                  <code className="mcpm-cmd">{source.url}</code>
                </div>
                <span className="mcpm-badge">
                  {source.kind === "registry"
                    ? t("settings.mcpMarket.kindRegistry")
                    : t("settings.mcpMarket.kindCatalog")}
                </span>
                {source.builtin ? null : (
                  <button
                    type="button"
                    className="mcpm-install is-ghost"
                    onClick={() => removeSource(source.id)}
                  >
                    {t("extensions.mcp.remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="mcpm-source-form">
            <Input
              value={draftSource.name}
              placeholder={t("settings.mcpMarket.namePlaceholder")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, name: event.target.value }))
              }
            />
            <Input
              value={draftSource.url}
              placeholder={t("settings.mcpMarket.urlHint")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, url: event.target.value }))
              }
            />
            <div className="mcpm-cats">
              {(["registry", "catalog"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={cx("mcpm-chip", draftSource.kind === kind && "is-active")}
                  onClick={() => setDraftSource((current) => ({ ...current, kind }))}
                >
                  {kind === "registry"
                    ? t("settings.mcpMarket.kindRegistry")
                    : t("settings.mcpMarket.kindCatalog")}
                </button>
              ))}
            </div>
            <button type="button" className="mcpm-install" onClick={addSource}>
              {t("settings.mcpMarket.addSource")}
            </button>
          </div>
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.mcpMarket.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="mcpm-install is-ghost"
              onClick={() => setSourcesOpen(false)}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="mcpm">
      <div className="mcpm-head">
        <div className="mcpm-head-copy">
          <button type="button" className="mcpm-back" onClick={onBack}>
            <IconChevronLeft size={14} />
            {t("settings.mcpMarket.back")}
          </button>
          <h3 className="mcpm-title">{t("settings.mcpMarket.title")}</h3>
          <p className="mcpm-subtitle">{t("settings.mcpMarket.subtitle")}</p>
        </div>
        <div className="mcpm-head-actions">
          <button type="button" className="mcpm-back" onClick={() => setSourcesOpen(true)}>
            {t("settings.mcpMarket.manageSources")} · {sources.length}
          </button>
        </div>
        <div className="mcpm-search">
          <Input
            className="mcpm-search-input"
            value={search}
            placeholder={t("settings.mcpMarket.searchPlaceholder")}
            aria-label={t("settings.mcpMarket.searchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="mcpm-cats" role="tablist" aria-label={t("settings.mcpMarket.title")}>
        {(["all", ...CATEGORIES] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            className={cx("mcpm-chip", category === id && "is-active")}
            onClick={() => setCategory(id)}
          >
            {id === "all"
              ? t("settings.mcpMarket.categoryAll")
              : t(`settings.mcpMarket.category.${id}`)}
          </button>
        ))}
      </div>

      {remote.status === "loading" ? (
        <p className="mcpm-status" role="status">
          {t("settings.mcpMarket.remoteLoading")}
        </p>
      ) : null}
      {remote.status === "error" ? (
        <p className="mcpm-status is-error" role="status">
          {t("settings.mcpMarket.remoteError")}
          {remote.failed.length ? ` (${remote.failed.join(", ")})` : ""}
        </p>
      ) : null}

      <div className="mcpm-list" role="list">
        {visible.length === 0 ? (
          <p className="mcpm-empty">{t("settings.mcpMarket.empty")}</p>
        ) : (
          visible.map((entry, index) => {
            const installed = installedIds.includes(entry.id);
            return (
              <article
                key={entry.id}
                role="listitem"
                className="mcpm-card"
                style={{ "--stagger": Math.min(index, 8) } as CSSProperties}
              >
                <span
                  className={cx("mcpm-glyph", `is-${entry.categories?.[0] ?? "devtools"}`)}
                  aria-hidden
                >
                  {entry.transport === "http" ? (
                    <IconServer size={17} />
                  ) : (
                    <IconTerminal size={17} />
                  )}
                </span>
                <div className="mcpm-card-body">
                  <div className="mcpm-card-title">
                    <span className="mcpm-name">{entry.name}</span>
                    {entry.verified ? (
                      <span className="mcpm-badge is-verified">
                        ✓ {t("settings.mcpMarket.verified")}
                      </span>
                    ) : null}
                    {remoteIds.has(entry.id) ? (
                      <span className="mcpm-badge is-remote">
                        {sourceName(entry.sourceId) ?? t("settings.mcpMarket.remoteBadge")}
                      </span>
                    ) : null}
                    {(entry.categories ?? []).slice(0, 1).map((id) => (
                      <span key={id} className="mcpm-badge">
                        {t(`settings.mcpMarket.category.${id}`)}
                      </span>
                    ))}
                  </div>
                  <code className="mcpm-cmd">
                    {entry.transport === "http"
                      ? (entry.url ?? "")
                      : [entry.command, ...(entry.args ?? [])].join(" ")}
                  </code>
                  <p className="mcpm-desc">{entry.description || entry.notes || ""}</p>
                </div>
                <div className="mcpm-card-actions">
                  <button
                    type="button"
                    className={cx("mcpm-install", installed && "is-installed")}
                    disabled={installed}
                    title={entry.homepage}
                    onClick={() => openInstall(entry)}
                  >
                    {installed
                      ? t("settings.mcpMarket.installed")
                      : t("settings.mcpMarket.install")}
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {installSheet}
      {sourcesSheet}
    </div>
  );
}
