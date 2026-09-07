import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TokenUsageBucket, TokenUsageHistoryItem, TokenUsageHistoryResult } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { IconActivity, IconReview } from "../icons";

const BUCKETS: TokenUsageBucket[] = ["day", "week", "month"];

function cellFill(value: number, max: number): string {
  if (value <= 0) return "var(--ds-tile)";
  const ratio = Math.min(value / Math.max(max, 1), 1);
  const mix = Math.round(28 + ratio * 72);
  return `color-mix(in oklab, var(--ds-success) ${mix}%, transparent)`;
}

function mondayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(year, month - 1, day).getDay();
  return weekday === 0 ? 6 : weekday - 1;
}

export function TokenUsagePage() {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<TokenUsageBucket>("day");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [data, setData] = useState<TokenUsageHistoryResult | null>(null);
  const [selected, setSelected] = useState<TokenUsageHistoryItem | null>(null);

  const fetchHistory = async (nextBucket: TokenUsageBucket) => {
    setLoading(true);
    setError(false);
    try {
      const res = await api.getTokenUsageHistory({ bucket: nextBucket });
      setData(res);
      setSelected(null);
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchHistory(bucket);
  }, [bucket]);

  const maxTokens = useMemo(() => {
    if (!data?.items.length) return 1;
    return Math.max(...data.items.map((item) => item.totalTokens), 1);
  }, [data]);

  const totals = data?.totals ?? {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };

  const dayCells = useMemo(() => {
    if (bucket !== "day" || !data?.items.length) return null;
    const pad = mondayIndex(data.items[0].date);
    return [...Array<TokenUsageHistoryItem | null>(pad).fill(null), ...data.items];
  }, [bucket, data]);

  const kpis = [
    { key: "settings.usageTotal", value: totals.totalTokens },
    { key: "settings.usageInput", value: totals.inputTokens },
    { key: "settings.usageOutput", value: totals.outputTokens },
    { key: "settings.usageTurns", value: totals.turnCount },
  ] as const;

  return (
    <div className="token-usage-page">
      <div className="token-usage-toolbar">
        <div className="settings-segment" role="group" aria-label={t("settings.usageActivity")}>
          {BUCKETS.map((item) => (
            <button
              key={item}
              type="button"
              className={`settings-segment-item${bucket === item ? " active" : ""}`}
              aria-pressed={bucket === item}
              onClick={() => setBucket(item)}
            >
              {t(
                item === "day"
                  ? "settings.usageDay"
                  : item === "week"
                    ? "settings.usageWeek"
                    : "settings.usageMonth",
              )}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void fetchHistory(bucket)}
          disabled={loading}
          aria-label={t("settings.usageRefresh")}
        >
          <IconReview className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      <div className="token-usage-kpis">
        {kpis.map((kpi) => (
          <div key={kpi.key} className="token-usage-kpi">
            <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {t(kpi.key)}
            </div>
            <div className="mt-1 text-xl font-semibold text-text-primary">
              {kpi.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="token-usage-heatmap-card">
        <div className="token-usage-heatmap-header">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <IconActivity />
            {t("settings.usageActivity")}
          </div>
          <div className="token-usage-legend text-xs text-text-muted">
            <span>{t("settings.usageLess")}</span>
            <span className="token-usage-swatch" />
            <span className="token-usage-swatch" style={{ backgroundColor: cellFill(1, 4) }} />
            <span className="token-usage-swatch" style={{ backgroundColor: cellFill(2, 4) }} />
            <span className="token-usage-swatch" style={{ backgroundColor: cellFill(3, 4) }} />
            <span className="token-usage-swatch" style={{ backgroundColor: cellFill(4, 4) }} />
            <span>{t("settings.usageMore")}</span>
          </div>
        </div>

        {error ? (
          <div className="py-10 text-center text-xs text-text-muted">{t("settings.usageLoadError")}</div>
        ) : loading && !data ? (
          <div className="py-10 text-center text-xs text-text-muted">{t("settings.usageRefresh")}</div>
        ) : !data || data.items.every((item) => item.turnCount === 0) ? (
          <div className="py-10 text-center text-xs text-text-muted">{t("settings.usageEmpty")}</div>
        ) : dayCells ? (
          <div className="token-usage-heatmap-layout">
            <div className="token-usage-weekdays" aria-hidden="true">
              <span>{t("settings.usageMon")}</span>
              <span />
              <span>{t("settings.usageWed")}</span>
              <span />
              <span>{t("settings.usageFri")}</span>
              <span />
              <span />
            </div>
            <div className="token-usage-heatmap" role="grid">
              {dayCells.map((item, index) =>
                item ? (
                  <HeatCell
                    key={item.date}
                    item={item}
                    max={maxTokens}
                    selected={selected?.date === item.date}
                    onSelect={setSelected}
                    label={t("settings.usageCell", {
                      date: item.date,
                      total: item.totalTokens.toLocaleString(),
                    })}
                  />
                ) : (
                  <span key={`pad-${index}`} className="token-usage-cell token-usage-cell-empty" />
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="token-usage-cells-wrap">
            {data.items.map((item) => (
              <HeatCell
                key={item.date}
                item={item}
                max={maxTokens}
                selected={selected?.date === item.date}
                onSelect={setSelected}
                label={t("settings.usageCell", {
                  date: item.date,
                  total: item.totalTokens.toLocaleString(),
                })}
              />
            ))}
          </div>
        )}

        {selected ? (
          <div className="token-usage-detail text-xs text-text-primary">
            <span className="font-semibold">{selected.date}</span>
            <span className="text-text-muted">
              {t("settings.usageTurns")}: {selected.turnCount.toLocaleString()}
            </span>
            <span>
              {t("settings.usageInput")}: {selected.inputTokens.toLocaleString()}
            </span>
            <span>
              {t("settings.usageOutput")}: {selected.outputTokens.toLocaleString()}
            </span>
            <span>
              {t("settings.usageTotal")}: {selected.totalTokens.toLocaleString()}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HeatCell({
  item,
  max,
  selected,
  onSelect,
  label,
}: {
  item: TokenUsageHistoryItem;
  max: number;
  selected: boolean;
  onSelect: (item: TokenUsageHistoryItem) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`token-usage-cell${selected ? " selected" : ""}`}
      style={{ backgroundColor: cellFill(item.totalTokens, max) }}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelect(item)}
    />
  );
}
