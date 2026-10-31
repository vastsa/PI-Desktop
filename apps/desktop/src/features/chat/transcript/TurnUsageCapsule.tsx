import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount, type MessageUsage } from "@pi-desktop/shared";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../../../lib/context-inspector-position";
import {
  turnUsageBreakdown,
  type TurnUsageBreakdown,
} from "../../../lib/context-usage";
import { portalToBody } from "../../../lib/portal-visibility";

const CLOSE_DELAY_MS = 120;

type CompositionSegment = {
  key: "cache" | "input" | "output" | "write";
  tokens: number;
};

function compositionSegments(
  breakdown: TurnUsageBreakdown,
): CompositionSegment[] {
  const segments: CompositionSegment[] = [
    { key: "cache", tokens: breakdown.cacheReadTokens },
    { key: "input", tokens: breakdown.inputTokens },
    { key: "output", tokens: breakdown.outputTokens },
    { key: "write", tokens: breakdown.cacheWriteTokens },
  ];
  return segments.filter((segment) => segment.tokens > 0);
}

/**
 * One proportional bar for the turn composition. Segments with no tokens are
 * omitted rather than painted at zero width; `flex-basis: 0` makes the inline
 * grow factor their only width input.
 */
function CompositionBar({ breakdown }: { breakdown: TurnUsageBreakdown }) {
  return (
    <span className="turn-usage-bar" aria-hidden="true">
      {compositionSegments(breakdown).map((segment) => (
        <span
          key={segment.key}
          className={`turn-usage-seg ${segment.key}`}
          style={{ flexGrow: segment.tokens }}
        />
      ))}
    </span>
  );
}

/**
 * Completed-turn usage capsule: speed and total stay visible, while the
 * composition and exact counts live in a hover/focus popover.
 *
 * The popover is pointer-open rather than click-toggled, so it leaves a short
 * grace window while the pointer crosses the gap between the capsule and the
 * panel. It portals to the body and clamps to `.main-pane` for the same reason
 * as the composer context inspector: the work panel's native surfaces compose
 * above every renderer layer.
 */
export function TurnUsageCapsule({
  usage,
  throughput,
  estimated = false,
}: {
  usage: MessageUsage;
  throughput?: number;
  /** Output tokens came from the interrupted-response estimate, not provider usage. */
  estimated?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const overTriggerRef = useRef(false);
  const overPanelRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ContextInspectorPlacement | null>(
    null,
  );

  const breakdown = turnUsageBreakdown(usage);
  const compactTotal = formatCompactTokenCount(breakdown.totalTokens);
  const speed =
    throughput === undefined
      ? t("chat.usageThroughputUnavailable")
      : t(
          estimated
            ? "chat.usageThroughputEstimated"
            : "chat.usageThroughput",
          {
            count: formatCompactTokenCount(throughput),
          },
        );
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    // Hovering the capsule and its panel keeps the popover open, and keyboard
    // focus owns it until focus moves away.
    if (
      overTriggerRef.current ||
      overPanelRef.current ||
      document.activeElement === triggerRef.current
    ) {
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setPosition(null);
    }, CLOSE_DELAY_MS);
  }, [cancelClose]);

  const openPopover = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    if (triggerRect.bottom <= 0 || triggerRect.top >= window.innerHeight) {
      setOpen(false);
      setPosition(null);
      return;
    }

    const popoverRect = popover.getBoundingClientRect();
    const paneRect = trigger.closest(".main-pane")?.getBoundingClientRect();
    const next = placeContextInspector({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      popover: { width: popoverRect.width, height: popoverRect.height },
      pane: paneRect ? { left: paneRect.left, right: paneRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!next) {
      setOpen(false);
      setPosition(null);
      return;
    }

    setPosition((previous) =>
      previous?.top === next.top &&
      previous.left === next.left &&
      previous.maxWidth === next.maxWidth
        ? previous
        : next,
    );
  }, []);

  useEffect(() => cancelClose, [cancelClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePosition]);

  // Sidebar and work-panel changes move the pane's right edge without a window
  // resize or scroll event, so the open popover watches the pane geometry.
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const pane = triggerRef.current?.closest(".main-pane");
    if (!pane) return;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [open, updatePosition]);

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
      cancelClose();
      setOpen(false);
      setPosition(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cancelClose();
      setOpen(false);
      setPosition(null);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelClose, open]);

  const popover = open ? (
    <div
      ref={popoverRef}
      id={panelId}
      className={`turn-usage-popover${position ? " is-open" : ""}`}
      role="dialog"
      aria-label={t("chat.usageTurnTotal")}
      style={
        position
          ? {
              top: `${position.top}px`,
              left: `${position.left}px`,
              maxWidth: `${position.maxWidth}px`,
            }
          : undefined
      }
      onPointerEnter={() => {
        overPanelRef.current = true;
        cancelClose();
      }}
      onPointerLeave={() => {
        overPanelRef.current = false;
        scheduleClose();
      }}
    >
      <div className="turn-usage-popover-head">
        <span className="turn-usage-popover-title">
          {t("chat.usageTurnTotal")}
        </span>
        <span className="turn-usage-popover-total">{compactTotal}</span>
      </div>
      <CompositionBar breakdown={breakdown} />
      <dl className="turn-usage-rows">
        <div className="turn-usage-row">
          <dt>{t("chat.usageCacheRead")}</dt>
          <dd>{numberFormat.format(breakdown.cacheReadTokens)}</dd>
        </div>
        <div className="turn-usage-row">
          <dt>{t("chat.usageInput")}</dt>
          <dd>{numberFormat.format(breakdown.inputTokens)}</dd>
        </div>
        <div className="turn-usage-row">
          <dt>{t("chat.usageOutput")}</dt>
          <dd>{numberFormat.format(breakdown.outputTokens)}</dd>
        </div>
        {breakdown.cacheWriteTokens > 0 ? (
          <div className="turn-usage-row">
            <dt>{t("chat.usageCacheWrite")}</dt>
            <dd>{numberFormat.format(breakdown.cacheWriteTokens)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="turn-usage-popover-footer">
        <span>{t("chat.usageTotal")}</span>
        <strong>{numberFormat.format(breakdown.totalTokens)}</strong>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="turn-usage-capsule"
        data-open={open ? "true" : "false"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t("chat.usageTurnAria", {
          speed,
          count: compactTotal,
        })}
        onPointerEnter={() => {
          overTriggerRef.current = true;
          openPopover();
        }}
        onPointerLeave={() => {
          overTriggerRef.current = false;
          scheduleClose();
        }}
        onFocus={openPopover}
        onBlur={scheduleClose}
        onClick={openPopover}
      >
        <CompositionBar breakdown={breakdown} />
        <span className="turn-usage-speed">{speed}</span>
        <span className="turn-usage-separator" aria-hidden="true">
          ·
        </span>
        <span className="turn-usage-total">{compactTotal}</span>
      </button>
      {popover && typeof document !== "undefined"
        ? portalToBody(popover)
        : null}
    </>
  );
}
