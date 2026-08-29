import { useId, useState } from "react";
import type { ModelBinding, ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import { Badge, Input, Select } from "../ui";
import { IconChevronDown, IconClose, IconImage, IconSparkles } from "../icons";

function formatTokens(value: number): string {
  return value > 0 ? value.toLocaleString("en-US") : "";
}

function compactTokens(value: number): string {
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

export function ModelConfigCard({
  binding,
  metadata,
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
  const levels = orderedLevels(binding.thinkingLevels);
  const supportsVision = metadata?.capabilities.includes("vision") === true;
  const modalities = metadata?.modalities;
  const modalitiesLabel = modalities
    ? `in: ${modalities.input.join(", ")} · out: ${modalities.output.join(", ")}`
    : undefined;
  const summaryLabel = `${contextWindowLabel}: ${formatTokens(binding.contextWindow)}; ${maxOutputLabel}: ${formatTokens(binding.maxTokens)}`;

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
              {THINKING_LEVELS.map((level) => {
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
      </div>

    </article>
  );
}
