import { useId, useState } from "react";
import type { ModelBinding, ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import { Badge, Input, Select } from "../ui";
import { IconChevronDown, IconClose, IconImage, IconSparkles } from "../icons";

function formatTokens(value: number): string {
  return value > 0 ? value.toLocaleString("en-US") : "";
}

function compactTokens(value?: number): string {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function parseTokens(value: string): number {
  const parsed = Number(value.replace(/,/g, "").replace(/[^0-9]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderedLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => levels.includes(level));
}

export type ModelMetadataLabels = {
  published: string;
  description: string;
  family: string;
  input: string;
  output: string;
  limits: string;
  provider: string;
  reasoningOptions: string;
  attachments: string;
  tools: string;
  structuredOutput: string;
  temperature: string;
  openWeights: string;
  knowledge: string;
  released: string;
  updated: string;
  pricing: string;
  experimental: string;
  enabled: string;
  disabled: string;
};

function metadataValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.npm === "string") return record.npm;
  if (typeof record.field === "string") return record.field;
  const keys = Object.keys(record);
  return keys.length > 0 ? keys.slice(0, 3).join(", ") : undefined;
}

function costSummary(cost: ModelInfo["cost"]): string | undefined {
  if (!cost) return undefined;
  const entries = [
    ["in", cost.input],
    ["out", cost.output],
    ["read", cost.cacheRead],
    ["write", cost.cacheWrite],
  ].filter(([, value]) => typeof value === "number");
  return entries.length > 0
    ? entries.map(([label, value]) => `${label} ${value}`).join(" · ")
    : undefined;
}

export function ModelConfigCard({
  binding,
  metadata,
  metadataLabels,
  initiallyExpanded,
  source,
  sourceLabel,
  customSourceLabel,
  visionLabel,
  textOnlyLabel,
  reasoningLabel,
  contextWindowLabel,
  contextWindowShortLabel,
  maxOutputLabel,
  maxOutputShortLabel,
  supportedThinkingLabel,
  defaultThinkingLabel,
  disabledThinkingLabel,
  disabledThinkingHint,
  levelLabels,
  removeLabel,
  onChange,
  onRemove,
}: {
  binding: ModelBinding;
  metadata?: ModelInfo | null;
  metadataLabels: ModelMetadataLabels;
  initiallyExpanded?: boolean;
  source: "catalog" | "custom";
  sourceLabel: string;
  customSourceLabel: string;
  visionLabel: string;
  textOnlyLabel: string;
  reasoningLabel: string;
  contextWindowLabel: string;
  contextWindowShortLabel: string;
  maxOutputLabel: string;
  maxOutputShortLabel: string;
  supportedThinkingLabel: string;
  defaultThinkingLabel: string;
  disabledThinkingLabel: string;
  disabledThinkingHint: string;
  levelLabels: Record<ThinkingLevel, string>;
  removeLabel: string;
  onChange: (update: Partial<ModelBinding>) => void;
  onRemove: () => void;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded ?? false);
  const publishedLevels = metadata?.supportedThinkingLevels;
  const availableLevels = metadata
    ? orderedLevels(
        publishedLevels?.length
          ? publishedLevels
          : metadata.reasoning
            ? ["low", "medium", "high"]
            : [],
      )
    : [...THINKING_LEVELS];
  const levels = orderedLevels(binding.thinkingLevels).filter((level) =>
    availableLevels.includes(level),
  );
  const supportsVision = metadata?.capabilities.includes("vision") === true;
  const modalities = metadata?.modalities;
  const modalitiesLabel = modalities
    ? `in: ${modalities.input.join(", ")} · out: ${modalities.output.join(", ")}`
    : undefined;
  const summaryLabel = `${contextWindowLabel}: ${compactTokens(binding.contextWindow)}; ${maxOutputLabel}: ${compactTokens(binding.maxTokens)}`;
  const metadataRows = metadata
    ? [
        [metadataLabels.family, metadata.family],
        [metadataLabels.input, modalities?.input.join(", ")],
        [metadataLabels.output, modalities?.output.join(", ")],
        [metadataLabels.limits, metadata.limit
          ? `ctx ${compactTokens(metadata.limit.context)} · in ${compactTokens(metadata.limit.input)} · out ${compactTokens(metadata.limit.output)}`
          : undefined],
        [metadataLabels.reasoningOptions, metadata.reasoningOptions
          ?.map((option) => `${option.type}${option.values?.length ? `: ${option.values.join("/")}` : ""}`)
          .join(" · ")],
        [metadataLabels.knowledge, metadata.knowledge],
        [metadataLabels.released, metadata.releaseDate],
        [metadataLabels.updated, metadata.lastUpdated],
        [metadataLabels.pricing, costSummary(metadata.cost)],
        [metadataLabels.provider, metadataValue(metadata.provider)],
        [metadataLabels.experimental, metadataValue(metadata.experimental)],
      ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0)
    : [];
  const metadataFlags = metadata
    ? [
        [metadataLabels.attachments, metadata.attachment],
        [metadataLabels.tools, metadata.toolCall],
        [metadataLabels.structuredOutput, metadata.structuredOutput],
        [metadataLabels.temperature, metadata.temperature],
        [metadataLabels.openWeights, metadata.openWeights],
      ].filter((row): row is [string, boolean] => typeof row[1] === "boolean")
    : [];

  const toggleLevel = (level: ThinkingLevel) => {
    const next = levels.includes(level)
      ? levels.filter((item) => item !== level)
      : orderedLevels([...levels, level]);
    const defaultThinkingLevel = next.includes(binding.defaultThinkingLevel as ThinkingLevel)
      ? binding.defaultThinkingLevel
      : next[0] ?? null;
    onChange({ thinkingLevels: next, defaultThinkingLevel });
  };

  return (
    <article className={`provider-model-card${expanded ? " is-expanded" : ""}`}>
      <div className="provider-model-card-head">
        <button
          type="button"
          className="provider-model-card-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="provider-model-card-chevron" aria-hidden="true">
            <IconChevronDown size={14} />
          </span>
          <span className="provider-model-card-toggle-main">
            <span className="provider-model-card-title-wrap">
              <span className="provider-model-card-id font-mono">{binding.id}</span>
              <Badge tone={source === "custom" ? "warning" : "neutral"}>
                {source === "custom" ? customSourceLabel : sourceLabel}
              </Badge>
              <span className="provider-model-capabilities" aria-label={`${binding.id} capabilities`}>
                <Badge tone={supportsVision ? "success" : "neutral"}>
                  <IconImage size={11} aria-hidden="true" />
                  {supportsVision ? visionLabel : textOnlyLabel}
                </Badge>
                {levels.length > 0 ? (
                  <Badge tone="neutral">
                    <IconSparkles size={11} aria-hidden="true" />
                    {reasoningLabel}
                  </Badge>
                ) : null}
                {modalitiesLabel ? (
                  <span className="provider-model-modalities" title={modalitiesLabel}>
                    {modalitiesLabel}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="provider-model-card-summary" aria-label={summaryLabel}>
              <span>
                <span className="provider-model-card-summary-label">{contextWindowShortLabel}</span>
                {compactTokens(binding.contextWindow)}
              </span>
              <span>
                <span className="provider-model-card-summary-label">{maxOutputShortLabel}</span>
                {compactTokens(binding.maxTokens)}
              </span>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="provider-model-card-remove"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div id={detailsId} className="provider-model-card-details" hidden={!expanded}>
        <div className="provider-model-card-limits">
          <label className="provider-model-card-field">
            <span>{contextWindowLabel}</span>
            <Input
              value={formatTokens(binding.contextWindow)}
              inputMode="numeric"
              onChange={(event) => onChange({ contextWindow: parseTokens(event.target.value) })}
              onBlur={() => onChange({ contextWindow: Math.max(1, binding.contextWindow) })}
              aria-label={`${binding.id} ${contextWindowLabel}`}
            />
          </label>
          <label className="provider-model-card-field">
            <span>{maxOutputLabel}</span>
            <Input
              value={formatTokens(binding.maxTokens)}
              inputMode="numeric"
              onChange={(event) => onChange({ maxTokens: parseTokens(event.target.value) })}
              onBlur={() => onChange({ maxTokens: Math.max(1, binding.maxTokens) })}
              aria-label={`${binding.id} ${maxOutputLabel}`}
            />
          </label>
        </div>

        <div className="provider-model-card-thinking">
          <div className="provider-model-card-thinking-label">{supportedThinkingLabel}</div>
          <div className="provider-model-card-thinking-row">
            <div className="provider-thinking-chips" role="group" aria-label={supportedThinkingLabel}>
              {availableLevels.map((level) => {
                const checked = levels.includes(level);
                return (
                  <button
                    key={level}
                    type="button"
                    className={`provider-thinking-chip${checked ? " selected" : ""}`}
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={levelLabels[level]}
                    onClick={() => toggleLevel(level)}
                  >
                    {levelLabels[level]}
                  </button>
                );
              })}
            </div>
            <label className="provider-default-thinking">
              <span>{defaultThinkingLabel}</span>
              <Select
                value={binding.defaultThinkingLevel ?? ""}
                disabled={levels.length === 0}
                onChange={(event) =>
                  onChange({
                    defaultThinkingLevel: (event.target.value || null) as ThinkingLevel | null,
                  })
                }
                aria-label={`${binding.id} ${defaultThinkingLabel}`}
              >
                {levels.length === 0 ? (
                  <option value="">{disabledThinkingLabel}</option>
                ) : (
                  levels.map((level) => (
                    <option key={level} value={level}>
                      {levelLabels[level]}
                    </option>
                  ))
                )}
              </Select>
            </label>
          </div>
          {levels.length === 0 ? (
            <div className="provider-thinking-disabled-hint">{disabledThinkingHint}</div>
          ) : null}
        </div>
        {metadata ? (
          <details className="provider-model-card-metadata">
            <summary>{metadataLabels.published}</summary>
            <div className="provider-model-metadata-body">
              {metadata.description ? (
                <p className="provider-model-metadata-description">{metadata.description}</p>
              ) : null}
              {metadataFlags.length > 0 ? (
                <div className="provider-model-metadata-flags" aria-label={metadataLabels.published}>
                  {metadataFlags.map(([label, value]) => (
                    <span key={label} className="provider-model-metadata-flag">
                      <span>{label}</span>
                      <strong>{value ? metadataLabels.enabled : metadataLabels.disabled}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              {metadataRows.length > 0 ? (
                <dl className="provider-model-metadata-grid">
                  {metadataRows.map(([label, value]) => (
                    <div key={label} className="provider-model-metadata-row">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>

    </article>
  );
}
