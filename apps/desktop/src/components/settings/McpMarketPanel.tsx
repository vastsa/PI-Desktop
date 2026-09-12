import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_MCP_CATALOG,
  GLOBAL_SCOPE,
  mergeRegistryEntries,
  resolveCatalogEntry,
  validateMcpCatalogFile,
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
};

const REMOTE_IDLE: RemoteState = { status: "idle", entries: [] };

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

  // The official registry is searched live (debounced); built-in picks render
  // immediately and stay as the offline floor when the registry is down.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setRemote((current) =>
        current.status === "idle" || current.status === "ready"
          ? { status: "loading", entries: current.entries }
          : current,
      );
      api
        .searchMcpMarketRegistry(search)
        .then((result) => {
          if (!cancelled) {
            setRemote({
              status: result.error ? "error" : "ready",
              entries: result.entries ?? [],
            });
          }
        })
        .catch(() => {
          if (!cancelled) setRemote({ status: "error", entries: [] });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

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
    );
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
                        {t("settings.mcpMarket.remoteBadge")}
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
    </div>
  );
}
