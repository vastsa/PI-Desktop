import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  formatCompactTokenCount,
  type ContextCompactionMark,
  type MessageUsage,
  type UiMessage,
} from "@pi-desktop/shared";
import {
  contextHistoryGroups,
  contextHistoryMessages,
  contextRequests,
  contextTrendPoints,
  contextUsageSegments,
  type ContextCategory,
  type ContextHistoryGroup,
  type ContextHistoryItem,
} from "../../../lib/context-insights";
import { aggregateToolTokenUsage, calculateCacheRate, calculateContextUsage } from "../../../lib/context-usage";
import { formatToolDuration } from "../../../lib/tool-display";
import type { SessionTimingView } from "./useSessionTiming";

const color = (key: string) => `var(--context-${key})`;
const categoryStyle = (key: string) => ({ "--context-color": color(key) }) as CSSProperties;

function Card({
  title,
  extra,
  children,
  className = "",
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`context-card ${className}`}>
      <header className="context-card-header">
        <h3>{title}</h3>
        {extra}
      </header>
      {children}
    </section>
  );
}

function Donut({
  segments,
  value,
  label,
}: {
  segments: { key: string; value: number }[];
  value: string;
  label: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  let offset = 0;
  return (
    <div className="context-donut" role="img" aria-label={`${label}: ${value}`}>
      <svg viewBox="0 0 100 100">
        <circle className="context-donut-track" cx="50" cy="50" r="40" />
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => {
            const share = (segment.value / total) * 100;
            const start = offset;
            offset += share;
            return (
              <circle
                key={segment.key}
                cx="50"
                cy="50"
                r="40"
                pathLength="100"
                style={{ stroke: color(segment.key) }}
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={-start}
              />
            );
          })}
      </svg>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function LegendRow({
  category,
  label,
  value,
  detail,
}: {
  category: string;
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="context-legend-row" style={categoryStyle(category)}>
      <i className="context-swatch" aria-hidden="true" />
      <span title={detail}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HistoryItem({ item, label }: { item: ContextHistoryItem; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="context-browser-item" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{item.label || label}</span>
        <strong>≈{formatCompactTokenCount(item.tokens)}</strong>
      </summary>
      {open ? <pre>{item.content}</pre> : null}
    </details>
  );
}

function HistoryGroup({ group, query, label }: { group: ContextHistoryGroup; query: string; label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = query
    ? group.items.filter((item) => `${item.label}\n${item.content}`.toLocaleLowerCase().includes(query))
    : group.items;
  return (
    <details
      className="context-browser-group"
      style={categoryStyle(group.category)}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <i className="context-swatch" aria-hidden="true" />
        <span>{label}</span>
        <span className="context-badge">
          {query ? `${items.length}/` : ""}
          {group.items.length}
        </span>
        <strong>≈{formatCompactTokenCount(group.tokens)}</strong>
      </summary>
      {open ? (
        <div className="context-browser-items">
          {items.length ? (
            items.map((item, index) => <HistoryItem key={item.id} item={item} label={`${label} ${index + 1}`} />)
          ) : (
            <p className="context-empty">{t(query ? "chat.insightsNoMatches" : "chat.insightsNoRecords")}</p>
          )}
        </div>
      ) : null}
    </details>
  );
}

export function ContextUsageDashboard({
  usage,
  contextWindow,
  messages,
  compactions,
  partial,
  timing,
  throughputLabel,
  timingValues,
  turnTools,
}: {
  usage: MessageUsage;
  contextWindow: number;
  messages: UiMessage[];
  compactions: readonly (ContextCompactionMark & { summary?: string })[];
  partial: boolean;
  timing: SessionTimingView;
  throughputLabel: string;
  timingValues: { network: string; model: string; tools: string };
  turnTools: UiMessage[];
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState("");
  const [granularity, setGranularity] = useState<"step" | "turn">("step");
  const [mode, setMode] = useState<"total" | "delta">("total");
  const [search, setSearch] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);
  const selectedBarRef = useRef<HTMLButtonElement>(null);
  const ordered = useMemo(() => contextHistoryMessages(messages), [messages]);
  const requests = useMemo(() => contextRequests(ordered, compactions), [ordered, compactions]);
  const selected = requests.find((request) => request.message.id === selectedId) ?? requests.at(-1);
  const groups = useMemo(
    () => contextHistoryGroups(selected ? ordered.slice(0, selected.index) : ordered),
    [ordered, selected],
  );
  const historyTokens = groups.reduce((sum, group) => sum + group.tokens, 0);
  const points = useMemo(() => contextTrendPoints(requests, granularity === "turn"), [requests, granularity]);
  const max = Math.max(1, ...points.map((point) => (mode === "delta" ? Math.abs(point.delta) : point.total)));
  const tools = useMemo(
    () =>
      aggregateToolTokenUsage(ordered.filter((message) => message.role === "tool")).sort(
        (a, b) => b.totalTokens - a.totalTokens,
      ),
    [ordered],
  );
  const turnToolRows = useMemo(() => aggregateToolTokenUsage(turnTools), [turnTools]);
  const selectedUsage = selected?.message.usage ?? usage;
  const segments = contextUsageSegments(selectedUsage);
  const current = calculateContextUsage(usage, contextWindow);
  const cacheRate = calculateCacheRate(selectedUsage.inputTokens, selectedUsage.cacheReadTokens);
  const latest = requests.at(-1);
  const scope = partial ? t("chat.insightsLoadedHistory") : t("chat.insightsSessionHistory");
  const requestLabel = (turn: number, step: number) => t("chat.insightsRequest", { turn, step });
  const pickedLabel = selected ? requestLabel(selected.turn, selected.step) : t("chat.insightsLatestRequest");
  const timingReady = timing.historyStatus === "ready";
  const timingSegments = [
    { key: "network", value: timingReady ? (timing.breakdown?.networkRequestMs ?? 0) : 0 },
    { key: "model", value: timingReady ? (timing.breakdown?.modelResponseMs ?? 0) : 0 },
    { key: "tools", value: timingReady ? (timing.breakdown?.toolCallMs ?? 0) : 0 },
  ];
  const timingTotal = timingSegments.reduce((sum, segment) => sum + segment.value, 0);
  const userCount = ordered.filter((message) => message.role === "user" && !message.steering).length;
  const elapsed = timing.timing ? formatToolDuration(timing.timing.elapsedMs / 1000) : "—";
  const providerKey = (key: string) => `chat.usage${key[0].toUpperCase()}${key.slice(1)}`;
  const categoryLabel = (category: ContextCategory) => t(`chat.insightsCategory_${category}`);
  const query = search.trim().toLocaleLowerCase();

  useEffect(() => {
    const chart = chartRef.current;
    const bar = selectedBarRef.current;
    if (!chart || !bar) return;
    const offset = bar.getBoundingClientRect().left - chart.getBoundingClientRect().left + chart.scrollLeft;
    chart.scrollLeft = Math.max(0, offset - (chart.clientWidth - bar.clientWidth) / 2);
  }, [selected?.message.id, granularity]);

  return (
    <div className="context-dashboard">
      <Card
        title={t("chat.insightsContextStats")}
        extra={<span className="context-badge">{scope}</span>}
        className="context-span"
      >
        <div className="context-stat-grid">
          {[
            [t("chat.insightsTurns"), userCount],
            [t("chat.insightsRequests"), requests.length],
            [t("chat.insightsToolCalls"), tools.reduce((sum, tool) => sum + tool.callCount, 0)],
            [t("chat.insightsCompactions"), compactions.at(-1)?.generation ?? 0],
            [t("chat.usageThroughputLabel"), throughputLabel],
          ].map(([label, value]) => (
            <div key={label} className="context-stat">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t("chat.insightsTokenStats")} extra={<span className="context-badge">{pickedLabel}</span>}>
        <div className="context-chart-legend">
          <Donut
            segments={segments.map((segment) => ({ key: segment.key, value: segment.tokens }))}
            value={formatCompactTokenCount(calculateContextUsage(selectedUsage, contextWindow).usedTokens)}
            label={t("chat.insightsReported")}
          />
          <div className="context-legend">
            {segments
              .filter((segment) => segment.tokens > 0 || segment.key === "input" || segment.key === "output")
              .map((segment) => (
                <LegendRow
                  key={segment.key}
                  category={segment.key}
                  label={t(providerKey(segment.key))}
                  value={formatCompactTokenCount(segment.tokens)}
                />
              ))}
            <LegendRow
              category="cacheRead"
              label={t("chat.usageCacheRate")}
              value={cacheRate === undefined ? "—" : `${cacheRate}%`}
            />
            {selectedUsage.reasoningTokens !== undefined ? (
              <div className="context-subset">
                {t("chat.insightsReasoningIncluded", { count: formatCompactTokenCount(selectedUsage.reasoningTokens) })}
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card
        title={t("chat.insightsTimingStats")}
        extra={
          <span className="context-badge">
            {t("chat.usageSessionTime")} · {elapsed}
          </span>
        }
      >
        <div className="context-chart-legend" aria-busy={timing.historyStatus === "loading"}>
          <Donut
            segments={timingSegments}
            value={timingReady && timingTotal > 0 ? formatToolDuration(timingTotal / 1000) : "—"}
            label={t("chat.insightsTimedActivity")}
          />
          <div className="context-legend">
            <LegendRow
              category="network"
              label={t("chat.usageNetworkRequest")}
              detail={t("chat.usageNetworkRequestHelp")}
              value={timingValues.network}
            />
            <LegendRow
              category="model"
              label={t("chat.usageModelResponse")}
              detail={t("chat.usageModelResponseHelp")}
              value={timingValues.model}
            />
            <LegendRow
              category="tools"
              label={t("chat.usageToolCalls")}
              detail={t("chat.usageToolCallsHelp")}
              value={timingValues.tools}
            />
          </div>
        </div>
      </Card>

      <Card
        title={t("chat.insightsCurrentContext")}
        extra={
          <span className="context-model" title={latest?.message.modelId}>
            {latest?.message.modelId}
          </span>
        }
        className="context-span"
      >
        <div className="context-capacity-heading">
          <span>
            <strong>{formatCompactTokenCount(current.usedTokens)}</strong> / {formatCompactTokenCount(contextWindow)}{" "}
            tokens
          </span>
          <span>{t("chat.insightsUsedPercent", { percent: current.usedPercent })}</span>
        </div>
        <div
          className="context-capacity"
          role="meter"
          aria-label={t("chat.usageContextWindow")}
          aria-valuenow={current.usedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={t("chat.usageContextTokens", {
            used: formatCompactTokenCount(current.usedTokens),
            window: formatCompactTokenCount(contextWindow),
          })}
        >
          {contextUsageSegments(usage).map((segment) => (
            <span
              key={segment.key}
              style={{
                background: color(segment.key),
                width: `${(segment.tokens / Math.max(contextWindow, current.usedTokens, 1)) * 100}%`,
              }}
            />
          ))}
        </div>
        <div className="context-capacity-legend">
          {contextUsageSegments(usage)
            .filter((segment) => segment.tokens > 0)
            .map((segment) => (
              <span key={segment.key} style={categoryStyle(segment.key)}>
                <i className="context-swatch" aria-hidden="true" />
                {t(providerKey(segment.key))} <strong>{formatCompactTokenCount(segment.tokens)}</strong>
              </span>
            ))}
          <span className="context-capacity-remaining">
            {t("chat.usageContextLeft", { count: formatCompactTokenCount(current.remainingTokens) })}
          </span>
        </div>
      </Card>

      <Card
        title={t("chat.insightsTrend")}
        extra={
          <div className="context-chart-controls">
            <div className="context-segmented" role="group" aria-label={t("chat.insightsGranularity")}>
              {(["step", "turn"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={granularity === value}
                  onClick={() => {
                    setGranularity(value);
                    if (value === "turn" && selectedId && selected) {
                      setSelectedId(
                        requests.filter((request) => request.turn === selected.turn).at(-1)?.message.id ?? "",
                      );
                    }
                  }}
                >
                  {t(`chat.insights_${value}`)}
                </button>
              ))}
            </div>
            <div className="context-segmented" role="group" aria-label={t("chat.insightsTrendMode")}>
              {(["total", "delta"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
                  {t(`chat.insights_${value}`)}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="context-trend-scale">
          <span>
            {mode === "delta" ? "±" : ""}
            {formatCompactTokenCount(max)}
          </span>
          <span>{t("chat.insightsReported")}</span>
        </div>
        <div ref={chartRef} className={`context-trend-scroll${mode === "delta" ? " is-delta" : ""}`}>
          <div className="context-trend-bars">
            {points.map(({ request, total, delta }) => (
              <button
                type="button"
                key={request.message.id}
                className="context-trend-column"
                ref={request.message.id === selected?.message.id ? selectedBarRef : undefined}
                aria-pressed={request.message.id === selected?.message.id}
                aria-label={`${requestLabel(request.turn, request.step)} · ${mode === "delta" && delta > 0 ? "+" : ""}${formatCompactTokenCount(mode === "delta" ? delta : total)} tokens`}
                title={`${requestLabel(request.turn, request.step)} · ${mode === "delta" && delta > 0 ? "+" : ""}${formatCompactTokenCount(mode === "delta" ? delta : total)} tokens${request.compactions.length ? ` · ${t("chat.insightsCompactions")}` : ""}`}
                onClick={() => setSelectedId(request.message.id)}
              >
                <span className="context-trend-bar-area">
                  <span
                    className={`context-trend-bar${delta < 0 && mode === "delta" ? " is-negative" : ""}`}
                    style={{
                      height: `${(Math.abs(mode === "delta" ? delta : total) / max) * (mode === "delta" ? 50 : 100)}%`,
                    }}
                  >
                    {mode === "total"
                      ? contextUsageSegments(request.message.usage).map((segment) => (
                          <i key={segment.key} style={{ background: color(segment.key), flexGrow: segment.tokens }} />
                        ))
                      : null}
                  </span>
                  {request.compactions.length ? (
                    <span className="context-trend-event" aria-hidden="true">
                      ✂
                    </span>
                  ) : null}
                </span>
                <span className="context-trend-label">
                  {request.turn}.{request.step}
                </span>
              </button>
            ))}
          </div>
          {!points.length ? <p className="context-empty">{t("chat.insightsNoRequests")}</p> : null}
        </div>
        <div className="context-step-brief">
          <strong>{pickedLabel}</strong>
          <span>{selected?.message.modelId}</span>
        </div>
        {selected?.message.content ? (
          <p className="context-step-response">{selected.message.content.slice(0, 240)}</p>
        ) : null}
      </Card>

      <Card
        title={t("chat.insightsBrowser")}
        className="context-browser"
        extra={
          <select
            aria-label={t("chat.insightsSelectRequest")}
            value={selectedId && selectedId === selected?.message.id ? selectedId : ""}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setGranularity("step");
            }}
          >
            <option value="">{t("chat.insightsLatestRequest")}</option>
            {requests.map((request) => (
              <option key={request.message.id} value={request.message.id}>
                {requestLabel(request.turn, request.step)}
              </option>
            ))}
          </select>
        }
      >
        <div className="context-browser-scope">
          <span>{t("chat.insightsRecordedBefore")}</span>
          <strong>≈{formatCompactTokenCount(historyTokens)} tokens</strong>
        </div>
        <div className="context-history-bar" aria-hidden="true">
          {groups.map((group) => (
            <span key={group.category} style={{ background: color(group.category), flexGrow: group.tokens }} />
          ))}
        </div>
        <input
          className="context-browser-search"
          type="search"
          aria-label={t("chat.insightsSearch")}
          placeholder={t("chat.insightsSearch")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="context-browser-groups">
          {groups.map((group) => (
            <HistoryGroup
              key={`${selected?.message.id ?? ""}:${group.category}`}
              group={group}
              query={query}
              label={categoryLabel(group.category)}
            />
          ))}
        </div>
        <p className="context-data-note">{t("chat.insightsHistoryNote")}</p>
      </Card>

      <Card title={t("chat.insightsToolRanking")} extra={<span className="context-badge">{scope} · ≈ tokens</span>}>
        <div className="context-tool-list">
          {tools.length ? (
            tools.map((tool) => (
              <div key={tool.toolName ?? ""} className="context-tool-row">
                <div>
                  <strong>{tool.toolName || t("chat.toolCall")}</strong>
                  <span>
                    {t("chat.insightsCalls", { count: tool.callCount })} · ≈{formatCompactTokenCount(tool.totalTokens)}
                  </span>
                </div>
                <div className="context-tool-track">
                  <span style={{ width: `${(tool.totalTokens / Math.max(1, tools[0].totalTokens)) * 100}%` }} />
                </div>
              </div>
            ))
          ) : (
            <p className="context-empty">{t("chat.insightsNoTools")}</p>
          )}
        </div>
        {turnTools.length ? (
          <div className="context-data-note">
            {t("chat.usageToolsSummary", {
              count: turnToolRows.length,
              calls: turnTools.length,
              tokens: formatCompactTokenCount(turnToolRows.reduce((sum, tool) => sum + tool.totalTokens, 0)),
            })}
          </div>
        ) : null}
      </Card>

      <Card title={t("chat.insightsEvents")} extra={<span className="context-badge">{compactions.length}</span>}>
        <div className="context-event-list">
          {compactions.length ? (
            [...compactions].reverse().map((mark) => (
              <details key={mark.id} className="context-event">
                <summary>
                  <span>✂ {t("chat.compactionRow", { times: mark.generation })}</span>
                  <strong>
                    {t(mark.summarized ? "chat.compactionRowSummary" : "chat.compactionRowNoSummary", {
                      tokens: formatCompactTokenCount(mark.summaryTokens),
                    })}
                  </strong>
                </summary>
                {mark.fallback || !mark.summarized ? (
                  <p>{t(mark.fallback ? "chat.compactionRowSummaryFailed" : "chat.compactionRowNoSummary")}</p>
                ) : mark.summary ? (
                  <pre>{mark.summary}</pre>
                ) : null}
              </details>
            ))
          ) : (
            <p className="context-empty">{t("chat.insightsNoEvents")}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
