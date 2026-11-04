import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ToolPackageSummary, ToolPackageTool } from "@pi-desktop/shared";

import { IconRefresh, IconWrench } from "../components/icons";
import { Badge, SettingsToggle, TooltipButton } from "../components/ui";
import { api } from "../lib/api";
import "../features/tools/tools.css";

/**
 * Tools: the tool packages this build ships (D681).
 *
 * A package is a directory under `resources/tools` with a `tool.json` manifest.
 * The host scans that directory and persists the enabled set, so this page is a
 * read-only view plus one switch per package — it never touches the filesystem
 * and never invents a package that the image does not carry.
 */
export function ToolsPage() {
  const { t } = useTranslation();
  const [packages, setPackages] = useState<ToolPackageSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await api.listToolPackages();
      setPackages(result.packages);
      setError("");
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      // The host answers with the fresh list, so one write settles every row.
      const result = await api.setToolPackageEnabled(id, enabled);
      setPackages(result.packages);
      setError("");
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="tools-page">
      <header className="tools-head">
        <div className="tools-title">
          <IconWrench size={16} aria-hidden />
          <h2>{t("tools.title")}</h2>
          {status === "ready" ? (
            <span className="tools-count">{t("tools.count", { count: packages.length })}</span>
          ) : null}
        </div>
        <TooltipButton
          type="button"
          className="tools-refresh"
          tooltip={t("tools.refresh")}
          ariaLabel={t("tools.refresh")}
          onClick={() => void load()}
        >
          <IconRefresh size={14} aria-hidden />
        </TooltipButton>
      </header>

      {status === "loading" ? (
        <p className="tools-placeholder">{t("tools.loading")}</p>
      ) : status === "error" ? (
        <p className="tools-placeholder is-error">
          {t("tools.loadFailed", { message: error })}
        </p>
      ) : packages.length === 0 ? (
        <div className="tools-empty">
          <p className="tools-empty-title">{t("tools.empty")}</p>
          <p className="tools-empty-hint">{t("tools.emptyHint")}</p>
        </div>
      ) : (
        <div className="tools-list">
          {packages.map((pkg) => (
            <article
              key={pkg.id}
              className={`tools-card${pkg.enabled ? "" : " is-disabled"}`}
              data-tool-package={pkg.id}
            >
              <div className="tools-card-head">
                <div className="tools-card-identity">
                  <span className="tools-card-name">{pkg.name}</span>
                  {pkg.version ? (
                    <Badge tone="neutral" className="tools-card-version">
                      {t("tools.version", { version: pkg.version })}
                    </Badge>
                  ) : null}
                  {pkg.id !== pkg.name ? (
                    <span className="tools-card-id">{pkg.id}</span>
                  ) : null}
                </div>
                <SettingsToggle
                  checked={pkg.enabled}
                  label={t("tools.enableLabel", { name: pkg.name })}
                  disabled={busyId === pkg.id}
                  onChange={() => void toggle(pkg.id, !pkg.enabled)}
                />
              </div>

              {pkg.error ? (
                <p className="tools-card-error" role="alert">
                  {t("tools.broken", { message: pkg.error })}
                </p>
              ) : (
                <>
                  {pkg.description ? (
                    <p className="tools-card-description">{pkg.description}</p>
                  ) : null}
                  {pkg.tools.length === 0 ? (
                    <p className="tools-card-note">{t("tools.noTools")}</p>
                  ) : (
                    <ul className="tools-tool-list">
                      {pkg.tools.map((tool) => (
                        <ToolRow key={tool.name} tool={tool} />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolRow({ tool }: { tool: ToolPackageTool }) {
  const { t } = useTranslation();
  const tone = tool.risk === "high" ? "error" : tool.risk === "medium" ? "warning" : "neutral";
  return (
    <li className="tools-tool">
      <code className="tools-tool-name">{tool.name}</code>
      {tool.risk ? (
        <Badge tone={tone} className="tools-tool-risk">
          {t(`tools.risk.${tool.risk}`)}
        </Badge>
      ) : null}
      {tool.description ? (
        <span className="tools-tool-description">{tool.description}</span>
      ) : null}
    </li>
  );
}
