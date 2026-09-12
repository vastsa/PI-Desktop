import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_MCP_CATALOG,
  GLOBAL_SCOPE,
  resolveCatalogEntry,
  validateMcpCatalogFile,
  type McpCatalogCategory,
  type McpCatalogEntry,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { CapabilityButton, CapabilityEmpty, CapabilityPanel, CapabilityRow } from "./AgentCapabilityLayout";
import { IconChevronLeft, IconServer, IconTerminal, IconX } from "../icons";
import { Button, Field, Input, TooltipButton, cx } from "../ui";

const CATEGORIES: readonly McpCatalogCategory[] = [
  "devtools",
  "web",
  "docs",
  "data",
  "productivity",
];

const { servers } = validateMcpCatalogFile(BUILTIN_MCP_CATALOG).catalog;

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

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return servers.filter((entry) => {
      if (category !== "all" && !(entry.categories ?? []).includes(category)) return false;
      if (!query) return true;
      return [entry.name, entry.description, entry.author]
        .filter(Boolean)
        .some((text) => text!.toLocaleLowerCase().includes(query));
    });
  }, [search, category]);

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
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) setInstallFor(null);
      }}
    >
      <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby="mcp-market-title">
        <div className="ext-sheet-head">
          <div>
            <h3 id="mcp-market-title" className="ext-sheet-title">
              {installFor.name}
            </h3>
            <p className="ext-sheet-sub">{installFor.description}</p>
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
            <code className="agent-capability-command">
              {installFor.transport === "http"
                ? installFor.url
                : [installFor.command, ...(installFor.args ?? [])].join(" ")}
            </code>
          </div>

          {installFor.prerequisites?.length ? (
            <p className="ext-field-hint">
              {t("settings.mcpMarket.prerequisites")}
              {installFor.prerequisites.join("；")}
            </p>
          ) : null}
          {installFor.notes ? (
            <p className="ext-field-hint">
              {t("settings.mcpMarket.notes")}
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
            <Button variant="ghost" onClick={() => setInstallFor(null)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void install()} disabled={saving}>
              {saving ? t("common.saving") : t("settings.mcpMarket.install")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="agent-capability-page">
      <div className="agent-capability-toolbar">
        <div className="agent-capability-toolbar-actions">
          <CapabilityButton title={t("settings.mcpMarket.back")} onClick={onBack}>
            <IconChevronLeft size={14} />
            {t("settings.mcpMarket.back")}
          </CapabilityButton>
        </div>
        <div className="agent-capability-search-wrap">
          <Input
            className="agent-capability-search"
            value={search}
            placeholder={t("settings.mcpMarket.searchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <p className="ext-field-hint">{t("settings.mcpMarket.subtitle")}</p>

      <div className="settings-segment agent-capability-segment" role="tablist">
        {(["all", ...CATEGORIES] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            className={cx("settings-segment-option", category === id && "is-active")}
            onClick={() => setCategory(id)}
          >
            {id === "all"
              ? t("settings.mcpMarket.categoryAll")
              : t(`settings.mcpMarket.category.${id}`)}
          </button>
        ))}
      </div>

      <CapabilityPanel loading={false} refreshing={false} loadingLabel="">
        <div className="agent-capability-list" role="list">
          {visible.length === 0 ? (
            <CapabilityEmpty message={t("settings.mcpMarket.empty")} icon={<IconServer size={18} />} />
          ) : (
            visible.map((entry) => {
              const installed = installedIds.includes(entry.id);
              return (
                <CapabilityRow
                  key={entry.id}
                  glyph={
                    entry.transport === "http" ? <IconServer size={16} /> : <IconTerminal size={16} />
                  }
                  name={entry.name}
                  command={
                    entry.transport === "http"
                      ? (entry.url ?? "")
                      : [entry.command, ...(entry.args ?? [])].join(" ")
                  }
                  description={entry.description || entry.notes || ""}
                  badges={
                    <>
                      {entry.verified ? (
                        <span className="agent-capability-badge is-level">
                          ✓ {t("settings.mcpMarket.verified")}
                        </span>
                      ) : null}
                      {(entry.categories ?? []).map((id) => (
                        <span key={id} className="agent-capability-badge">
                          {t(`settings.mcpMarket.category.${id}`)}
                        </span>
                      ))}
                    </>
                  }
                  actions={
                    <CapabilityButton
                      variant="primary"
                      disabled={installed}
                      title={entry.homepage}
                      onClick={() => openInstall(entry)}
                    >
                      {installed ? t("settings.mcpMarket.installed") : t("settings.mcpMarket.install")}
                    </CapabilityButton>
                  }
                />
              );
            })
          )}
        </div>
      </CapabilityPanel>

      {installSheet}
    </div>
  );
}
