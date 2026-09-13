import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MessageUsage, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { TooltipButton } from "./ui";
import {
  aggregateToolTokenUsage,
  calculateCacheRate,
  calculateContextUsage,
  calculateTokenRate,
  contextOccupancyTokens,
  contextUsageView,
  resolveContextUsageDisplay,
} from "../lib/context-usage";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../lib/context-inspector-position";

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

const CONTEXT_RING_RADIUS = 9;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

export function ContextUsageInspector({
  usage,
  turnUsage,
  contextWindow,
  tools,
  responseDurationMs,
  responseOutputTokens,
  responseOutputEstimated = false,
}: {
  usage: MessageUsage;
  turnUsage: MessageUsage;
  contextWindow: number;
  tools: UiMessage[];
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated?: boolean;
}) {
  const { t } = useTranslation();
  const panelId = useId();
  // The transcript shows one row per compaction; the inspector adds what those
  // rows cannot — how much of the model context the newest summary occupies.
  const compaction = useAppStore((state) =>
    state.activeSessionId
      ? state.sessionCompactions[state.activeSessionId]?.at(-1)
      : undefined,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] =
    useState<ContextInspectorPlacement | null>(null);
  const context = calculateContextUsage(usage, contextWindow);
  // The display preference flips the leading figure only; capacity colors
  // still follow remaining space so the warning state keeps one meaning.
  const usageDisplay = useAppStore((state) =>
    resolveContextUsageDisplay(state.settings?.contextUsageDisplay),
  );
  const display = contextUsageView(context, usageDisplay);
  // Occupancy, turn total, and provider cache/input/output are the last
  // model request. Summing every tool-loop call inflates cache read past
  // the window (OpenCode last-message accounting).
  const turnTotal = contextOccupancyTokens(usage);
  const throughput = calculateTokenRate(
    responseOutputTokens ?? turnUsage.outputTokens,
    responseDurationMs,
  );
  const cacheRate = calculateCacheRate(
    usage.inputTokens,
    usage.cacheReadTokens,
  );
  const toolRows = aggregateToolTokenUsage(tools);
  const toolTotal = toolRows.reduce(
    (total, row) => total + row.totalTokens,
    0,
  );
  const level =
    context.remainingPercent <= 10
      ? "critical"
      : context.remainingPercent <= 25
        ? "warning"
        : "comfortable";
  // One accessible sentence serves both display modes: the localized `state`
  // phrase carries "remaining"/"used", so the key stays literal for the
  // tooltip contract while `percent`/`count` stay numeric.
  const ariaArguments = {
    percent: display.percent,
    count: formatTokenCount(display.tokens),
    state:
      display.display === "used"
        ? t("chat.usageContextAriaUsed")
        : t("chat.usageContextAriaRemaining"),
  };

  const closeInspector = useCallback(() => {
    setOpen(false);
    setPopoverPosition(null);
  }, []);

  // The panel is click-toggled rather than hover-opened: reading the token
  // breakdown takes long enough that a pointer leaving the trigger should not
  // dismiss it.
  const toggleInspector = useCallback(() => {
    setOpen((previous) => {
      if (previous) setPopoverPosition(null);
      return !previous;
    });
  }, []);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const triggerVisible =
      triggerRect.bottom > 0 && triggerRect.top < window.innerHeight;
    if (!triggerVisible) {
      setOpen(false);
      setPopoverPosition(null);
      return;
    }
    const popoverRect = popover.getBoundingClientRect();
    // Clamp against the conversation pane rather than the viewport: the pane
    // ends where the work panel begins, and the panel's native browser/plugin
    // surfaces composite above every renderer layer, so whatever part of the
    // popover crosses that edge is covered whatever z-index it carries (D357).
    const paneRect = trigger.closest(".main-pane")?.getBoundingClientRect();
    const placement = placeContextInspector({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      popover: { width: popoverRect.width, height: popoverRect.height },
      pane: paneRect ? { left: paneRect.left, right: paneRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!placement) {
      setOpen(false);
      setPopoverPosition(null);
      return;
    }

    setPopoverPosition((previous) =>
      previous?.top === placement.top &&
      previous.left === placement.left &&
      previous.maxWidth === placement.maxWidth
        ? previous
        : placement,
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePopoverPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [
    compaction,
    context.usedTokens,
    contextWindow,
    open,
    toolRows.length,
    toolTotal,
    turnTotal,
    throughput,
    updatePopoverPosition,
  ]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => updatePopoverPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open || !popoverRef.current || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updatePopoverPosition);
    observer.observe(popoverRef.current);
    return () => observer.disconnect();
  }, [open, updatePopoverPosition]);

  // Sidebar toggle/resize, work-panel open/resize, and the panel's entrance
  // animation all move the pane's right edge without emitting a window resize
  // or a scroll event (#246). A stale clamp would leave part of the popover
  // under the panel's native surfaces, so the open popover observes the pane
  // and re-runs placement whenever its box changes.
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const pane = triggerRef.current?.closest(".main-pane");
    if (!pane) return;
    const observer = new ResizeObserver(updatePopoverPosition);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      closeInspector();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeInspector();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeInspector, open]);

  const popover = open ? (
    <div
      ref={popoverRef}
      className={`context-inspector-popover${popoverPosition ? " is-open" : ""}`}
      id={panelId}
      role="dialog"
      aria-label={t("chat.usageContextLabel")}
      style={
        popoverPosition
          ? {
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              maxWidth: `${popoverPosition.maxWidth}px`,
            }
          : undefined
      }
    >
      <div className="context-inspector-heading">
        <strong className="context-inspector-heading-value">
          {display.display === "used"
            ? t("chat.usageContextSpent", {
                count: formatTokenCount(display.tokens),
              })
            : t("chat.usageContextLeft", {
                count: formatTokenCount(display.tokens),
              })}
        </strong>
        <strong className="context-inspector-heading-percent">
          {display.percent}%
        </strong>
      </div>
      <div className="context-inspector-window">
        <span>{t("chat.usageContextWindow")}</span>
        <strong>
          {t("chat.usageContextTokens", {
            used: formatTokenCount(context.usedTokens),
            window: formatTokenCount(contextWindow),
          })}
        </strong>
        <span className="context-inspector-window-percent">
          {context.usedPercent}%
        </span>
      </div>
      <div className="context-inspector-kpis">
        <div>
          <span>{t("chat.usageTurnTotal")}</span>
          <strong>{formatTokenCount(turnTotal)}</strong>
        </div>
        <div>
          <span>{t("chat.usageThroughputLabel")}</span>
          <strong>
            {throughput === undefined
              ? t("chat.usageThroughputUnavailable")
              : t(
                  responseOutputEstimated
                    ? "chat.usageThroughputEstimated"
                    : "chat.usageThroughput",
                  {
                    count: formatTokenCount(throughput),
                  },
                )}
          </strong>
        </div>
      </div>
      <div className="context-inspector-summary">
        <div className="context-inspector-summary-row">
          <strong>{t("chat.usageProviderUsage")}</strong>
          <span className="context-inspector-summary-values">
            <span>
              {t("chat.usageInput")} {formatTokenCount(usage.inputTokens)}
            </span>
            <span>
              {t("chat.usageOutput")} {formatTokenCount(usage.outputTokens)}
            </span>
            {usage.cacheReadTokens !== undefined ? (
              <span>
                {t("chat.usageCacheRead")} {formatTokenCount(usage.cacheReadTokens)}
              </span>
            ) : null}
            {cacheRate !== undefined ? (
              <span>
                {t("chat.usageCacheRate")} {cacheRate}%
              </span>
            ) : null}
            {usage.cacheWriteTokens !== undefined ? (
              <span>
                {t("chat.usageCacheWrite")} {formatTokenCount(usage.cacheWriteTokens)}
              </span>
            ) : null}
            {usage.reasoningTokens !== undefined ? (
              <span>
                {t("chat.usageReasoning")} {formatTokenCount(usage.reasoningTokens)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="context-inspector-summary-row">
          <strong>{t("chat.usageTools")}</strong>
          <span className="context-inspector-summary-values">
            {toolRows.length > 0
              ? t("chat.usageToolsSummary", {
                  count: toolRows.length,
                  calls: tools.length,
                  tokens: formatTokenCount(toolTotal),
                })
              : t("chat.usageNoTools")}
          </span>
        </div>
      </div>
      {compaction ? (
        <div className="context-inspector-compaction">
          <span>
            {t("chat.usageCompaction", { times: compaction.generation })}
          </span>
          <strong>~{formatTokenCount(compaction.summaryTokens)}</strong>
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      className="context-inspector"
      data-level={level}
      data-open={open ? "true" : "false"}
    >
      <TooltipButton
        ref={triggerRef}
        type="button"
        className="context-inspector-trigger"
        tooltip={t("chat.usageContextAria", ariaArguments)}
        ariaLabel={t("chat.usageContextAria", ariaArguments)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggleInspector}
      >
        <svg
          className="context-inspector-ring"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="context-inspector-ring-track"
            cx="12"
            cy="12"
            r={CONTEXT_RING_RADIUS}
          />
          <circle
            className="context-inspector-ring-progress"
            cx="12"
            cy="12"
            r={CONTEXT_RING_RADIUS}
            strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
            strokeDashoffset={
              CONTEXT_RING_CIRCUMFERENCE * (1 - display.ratio)
            }
          />
        </svg>
        <span className="context-inspector-ring-value">
          {display.percent}%
        </span>
      </TooltipButton>
      {popover && typeof document !== "undefined"
        ? createPortal(popover, document.body)
        : null}
    </div>
  );
}
