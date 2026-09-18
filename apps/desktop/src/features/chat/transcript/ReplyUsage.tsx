import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { formatTokenCount, type MessageUsage } from "@pi-desktop/shared";
import {
  IconCheck,
  IconClock,
  IconCopy,
  IconDatabase,
} from "../../../components/icons";
import { useCopy } from "../../../components/Markdown";
import {
  calculateCacheRate,
  calculateTokenRate,
} from "../../../lib/context-usage";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../../../lib/context-inspector-position";
import {
  formatClockTime,
  formatTimingDuration,
} from "../../../lib/message-timing";

/**
 * A duration the way a person reads a stopwatch: "11m 25s" in the active
 * locale, with the seconds always kept so a short reply still shows a number.
 */
function durationLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  ms: number,
): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(t("chat.durationHours", { count: hours }));
  if (minutes > 0) parts.push(t("chat.durationMinutes", { count: minutes }));
  if (seconds > 0 || parts.length === 0) {
    parts.push(t("chat.durationSeconds", { count: seconds }));
  }
  return parts.join(" ");
}

type ReadoutRow = { key: string; label: string; value: string };

/**
 * One segment of the readout plus the card it opens.
 *
 * Each segment owns its own card (D447): how much the turn cost and how long it
 * took answer different questions, so a click shows only the one that was
 * asked about. The card is portaled and placed in viewport coordinates for the
 * same reason the composer inspector is (D357) — the transcript scroller would
 * clip a descendant, and the work panel's native surfaces composite above every
 * renderer layer.
 */
function ReadoutPopover({
  segment,
  icon,
  title,
  heading,
  rows,
}: {
  segment: ReactNode;
  /** Card-heading glyph, matching the segment that opened it. */
  icon: ReactNode;
  title: string;
  /** Right side of the card heading, for a card that carries a total. */
  heading?: string;
  rows: readonly ReadoutRow[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] =
    useState<ContextInspectorPlacement | null>(null);
  const cardId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The card opens on click alone (D447): hovering it used to open on the way
  // to selecting its text, which is the one thing a reader wants to do with it.
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (!node) return;
      if (triggerRef.current?.contains(node)) return;
      if (cardRef.current?.contains(node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [open]);

  const updatePlacement = useCallback(() => {
    const trigger = triggerRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const triggerRect = trigger.getBoundingClientRect();
    const triggerVisible =
      triggerRect.bottom > 0 && triggerRect.top < window.innerHeight;
    if (!triggerVisible) {
      setOpen(false);
      setPlacement(null);
      return;
    }
    const cardRect = card.getBoundingClientRect();
    // Clamp against the conversation pane, not the viewport: the pane ends
    // where the work panel begins, and the panel's native surfaces cover
    // anything that crosses it (D357).
    const paneRect = trigger.closest(".main-pane")?.getBoundingClientRect();
    const next = placeContextInspector({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      popover: { width: cardRect.width, height: cardRect.height },
      pane: paneRect ? { left: paneRect.left, right: paneRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!next) {
      setOpen(false);
      setPlacement(null);
      return;
    }
    setPlacement((previous) =>
      previous?.top === next.top &&
      previous.left === next.left &&
      previous.maxWidth === next.maxWidth
        ? previous
        : next,
    );
  }, []);

  useEffect(() => {
    if (!open) setPlacement(null);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePlacement);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePlacement, rows.length]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open, updatePlacement]);

  const card = open ? (
    <div
      ref={cardRef}
      id={cardId}
      className={`reply-usage-card${placement ? " is-open" : ""}`}
      role="dialog"
      aria-label={title}
      style={
        placement
          ? {
              top: `${placement.top}px`,
              left: `${placement.left}px`,
              maxWidth: `${placement.maxWidth}px`,
            }
          : undefined
      }
    >
      <div className="reply-usage-card-heading">
        <span className="reply-usage-card-title">
          {icon}
          {title}
        </span>
        <span className="reply-usage-card-heading-value">
          {heading === undefined ? null : <strong>{heading}</strong>}
          <button
            type="button"
            className={`copy-btn icon reply-usage-copy${copied ? " copied" : ""}`}
            title={copied ? t("chat.copied") : t("chat.copy")}
            aria-label={copied ? t("chat.copied") : t("chat.copy")}
            onClick={() =>
              copy(
                [
                  heading === undefined ? title : `${title}: ${heading}`,
                  ...rows.map((row) => `${row.label}: ${row.value}`),
                ].join("\n"),
              )
            }
          >
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </button>
        </span>
      </div>
      <div className="reply-usage-card-rows">
        {rows.map((row) => (
          <div className="reply-usage-card-row" key={row.key}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="reply-usage-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={() => setOpen((value) => !value)}
        title={title}
      >
        {segment}
      </button>
      {card ? createPortal(card, document.body) : null}
    </>
  );
}

export type ReplyUsageProps = {
  modelId?: string;
  /** Provider-reported usage summed over every reply in this turn. */
  usage?: MessageUsage;
  responseDurationMs?: number;
  responseOutputTokens?: number;
  /** True when part of this turn's output count is the runtime's estimate. */
  responseOutputEstimated?: boolean;
  /** Provider request → first streamed token, in milliseconds. */
  firstTokenMs?: number;
  /** Local clock time the last assistant stream of this turn ended. */
  completedAt?: string;
  /** The prompt's send time → that completion time, in milliseconds. */
  totalMs?: number;
};

/**
 * The per-reply readout: one compact line whose usage and elapsed segments each
 * open their own card (D447, D448).
 */
export function ReplyUsage({
  modelId,
  usage,
  responseDurationMs,
  responseOutputTokens,
  responseOutputEstimated,
  firstTokenMs,
  completedAt,
  totalMs,
}: ReplyUsageProps) {
  const { t } = useTranslation();
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens;
  const cacheWriteTokens = usage?.cacheWriteTokens;
  const reasoningTokens = usage?.reasoningTokens ?? 0;
  // What the turn actually cost: the uncached prompt, the cache it read and
  // wrote, and what the model wrote back — the same four fields the composer's
  // session row sums (D449).
  const reportedTokens = usage
    ? inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens
    : undefined;
  // A stopped stream can end without any usage bucket, carrying only the
  // runtime's estimate of what it did print. That summary is then the turn's
  // whole total, so the segment and its card still render and the rate row
  // stays reachable (D448).
  const estimatedTokens =
    responseOutputTokens !== undefined && responseOutputTokens > 0
      ? responseOutputTokens
      : undefined;
  const totalTokens = reportedTokens ?? estimatedTokens;
  const cacheRate =
    cacheReadTokens !== undefined
      ? calculateCacheRate(inputTokens, cacheReadTokens)
      : undefined;
  // A part-estimated turn divides a complete count: the runtime's summary
  // covers both halves, while the provider's output count only covers the
  // reported ones. A reported turn prefers the provider's exact count.
  const throughput = calculateTokenRate(
    responseOutputEstimated
      ? (estimatedTokens ?? outputTokens)
      : (usage?.outputTokens ?? estimatedTokens ?? 0),
    responseDurationMs,
  );
  const rateLabel =
    throughput === undefined
      ? undefined
      : usage && !responseOutputEstimated
        ? t("chat.usageThroughput", { count: formatTokenCount(throughput) })
        : t("chat.usageThroughputEstimated", {
            count: formatTokenCount(throughput),
          });
  const completedTime = completedAt ? formatClockTime(completedAt) : undefined;
  const elapsed =
    totalMs === undefined ? undefined : durationLabel(t, Math.max(0, totalMs));
  const tokenUnit = t("chat.tokenUnit");

  const usageRows: ReadoutRow[] = [
    ...(modelId === undefined
      ? []
      : [{ key: "provider", label: t("chat.replyUsageProvider"), value: modelId }]),
    ...(cacheRate === undefined
      ? []
      : [
          {
            key: "cache-rate",
            label: t("chat.usageCacheRate"),
            value: `${cacheRate}%`,
          },
        ]),
    ...(usage === undefined
      ? []
      : [
          {
            key: "uncached",
            label: t("chat.usageUncachedInput"),
            value: formatTokenCount(inputTokens),
          },
        ]),
    ...(cacheReadTokens === undefined
      ? []
      : [
          {
            key: "cache-read",
            label: t("chat.usageCacheRead"),
            value: formatTokenCount(cacheReadTokens),
          },
        ]),
    ...(cacheWriteTokens === undefined || cacheWriteTokens <= 0
      ? []
      : [
          {
            key: "cache-write",
            label: t("chat.usageCacheWrite"),
            value: formatTokenCount(cacheWriteTokens),
          },
        ]),
    ...(usage === undefined
      ? []
      : [
          {
            key: "output",
            label: t("chat.usageOutput"),
            // The unit belongs to the heading: these rows are all token counts.
            value:
              reasoningTokens > 0
                ? `${formatTokenCount(outputTokens)}${t("chat.replyUsageReasoningSuffix", { count: formatTokenCount(reasoningTokens) })}`
                : formatTokenCount(outputTokens),
          },
        ]),
    ...(rateLabel === undefined
      ? []
      : [
          {
            key: "rate",
            label: t("chat.usageThroughputLabel"),
            value: rateLabel,
          },
        ]),
  ];

  // What the elapsed segment advertises, spelled out on its own card: the wait
  // for the first token and the whole duration.
  const timingRows: ReadoutRow[] = [
    ...(elapsed === undefined
      ? []
      : [
          {
            key: "elapsed",
            label: t("chat.timingElapsedLabel"),
            value: elapsed,
          },
        ]),
    ...(firstTokenMs === undefined
      ? []
      : [
          {
            key: "first-token",
            label: t("chat.timingFirstTokenLabel"),
            value: formatTimingDuration(firstTokenMs),
          },
        ]),
  ];

  const usageSegment =
    totalTokens === undefined ? null : (
      <span className="reply-usage-segment">
        <IconDatabase size={12} aria-hidden />
        {`${t("chat.replyUsageLabel")} ${formatTokenCount(totalTokens)} ${tokenUnit}`}
      </span>
    );
  const elapsedSegment =
    elapsed === undefined ? null : (
      <span className="reply-usage-segment">
        <IconClock size={12} aria-hidden />
        {t("chat.timingElapsed", { time: elapsed })}
      </span>
    );
  const doneSegment =
    completedTime === undefined ? null : (
      <span className="reply-usage-segment">{completedTime}</span>
    );

  if (usageSegment === null && elapsedSegment === null && doneSegment === null) {
    return null;
  }

  return (
    <span className="reply-usage-line">
      {usageSegment === null || usageRows.length === 0 ? null : (
        <ReadoutPopover
          segment={usageSegment}
          icon={<IconDatabase size={13} aria-hidden />}
          title={t("chat.replyUsageTitle")}
          heading={`${formatTokenCount(totalTokens ?? 0)} ${tokenUnit}`}
          rows={usageRows}
        />
      )}
      {elapsedSegment === null || timingRows.length === 0 ? null : (
        <ReadoutPopover
          segment={elapsedSegment}
          icon={<IconClock size={13} aria-hidden />}
          title={t("chat.timingCardTitle")}
          rows={timingRows}
        />
      )}
      {doneSegment}
    </span>
  );
}
