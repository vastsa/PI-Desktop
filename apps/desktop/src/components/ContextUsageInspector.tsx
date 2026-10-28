import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { portalToBody } from "../lib/portal-visibility";
import { useTranslation } from "react-i18next";
import {
  formatCompactTokenCount,
  type ContextCompactionMark,
  type MessageUsage,
  type UiMessage,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { formatToolDuration } from "../lib/tool-display";
import { TooltipButton } from "./ui";
import {
  calculateContextUsage,
  calculateTokenRate,
  contextUsageView,
  resolveContextUsageDisplay,
} from "../lib/context-usage";
import {
  placeContextInspector,
  type ContextInspectorPlacement,
} from "../lib/context-inspector-position";
import { useSessionTiming } from "../features/chat/context-usage/useSessionTiming";
import { ContextUsageDashboard } from "../features/chat/context-usage/ContextUsageDashboard";

const CONTEXT_RING_RADIUS = 9;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
const EMPTY_COMPACTIONS: readonly ContextCompactionMark[] = [];

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
  // The transcript shows one row per compaction; the dashboard adds what those
  // rows cannot — how much of the model context each summary occupies and when
  // the checkpoints land inside the trend.
  const compactions = useAppStore((state) =>
    state.activeSessionId
      ? state.sessionCompactions[state.activeSessionId]
      : undefined,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] =
    useState<ContextInspectorPlacement | null>(null);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId),
  );
  const sessionMessages = useAppStore((state) => state.messages);
  const sessionHistory = useAppStore((state) =>
    state.activeSessionId
      ? state.sessionHistory[state.activeSessionId]
      : undefined,
  );
  const isSessionRunning = useAppStore((state) =>
    state.activeSessionId
      ? state.runningSessions[state.activeSessionId] ?? state.isRunning
      : false,
  );
  const modelRequestActivity = useAppStore((state) =>
    state.activeSessionId
      ? state.agentStatuses[state.activeSessionId]?.activity
      : undefined,
  );
  const sessionTiming = useSessionTiming({
    enabled: open,
    session,
    sessionId,
    messages: sessionMessages,
    history: sessionHistory,
    isRunning: isSessionRunning,
    modelRequestActivity,
  });
  const context = calculateContextUsage(usage, contextWindow);
  // The display preference flips the leading figure only; capacity colors
  // still follow remaining space so the warning state keeps one meaning.
  const usageDisplay = useAppStore((state) =>
    resolveContextUsageDisplay(state.settings?.contextUsageDisplay),
  );
  const display = contextUsageView(context, usageDisplay);
  const throughput = calculateTokenRate(
    responseOutputTokens ?? turnUsage.outputTokens,
    responseDurationMs,
  );
  const formatTimingValue = (durationMs?: number, percent?: number) => {
    if (sessionTiming.historyStatus === "loading") return "…";
    if (sessionTiming.historyStatus === "error" || durationMs === undefined) {
      return t("chat.usageTimingUnavailable");
    }
    return `${formatToolDuration(durationMs / 1_000)}${
      percent === undefined ? "" : ` · ${percent}%`
    }`;
  };
  const timingBreakdown = sessionTiming.breakdown;
  const networkRequestValue = formatTimingValue(
    timingBreakdown?.networkRequestMs,
    timingBreakdown?.networkRequestPercent,
  );
  const modelResponseValue = formatTimingValue(
    timingBreakdown?.modelResponseMs,
    timingBreakdown?.modelResponsePercent,
  );
  const toolCallValue = formatTimingValue(
    timingBreakdown?.toolCallMs,
    timingBreakdown?.toolCallPercent,
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
    count: formatCompactTokenCount(display.tokens),
    state:
      display.display === "used"
        ? t("chat.usageContextAriaUsed")
        : t("chat.usageContextAriaRemaining"),
  };

  const closeInspector = useCallback(() => {
    setOpen(false);
    setPopoverPosition(null);
  }, []);

  // The dashboard describes one session. Switching leaves the open panel
  // quoting a transcript it no longer owns, so it dismisses instead of
  // reloading in place.
  useEffect(() => {
    closeInspector();
  }, [sessionId, closeInspector]);

  // Opening moves focus into the dialog so Escape and Tab act on the panel
  // rather than the Composer behind it.
  useEffect(() => {
    if (!open || !popoverPosition) return;
    popoverRef.current
      ?.querySelector<HTMLButtonElement>(".context-inspector-close")
      ?.focus({ preventScroll: true });
  }, [open, popoverPosition]);

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
    compactions,
    context.usedTokens,
    contextWindow,
    open,
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
      aria-label={t("chat.insightsTitle")}
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
      <header className="context-inspector-titlebar">
        <div>
          <strong>{t("chat.insightsTitle")}</strong>
          <span>{session?.title}</span>
        </div>
        <button
          type="button"
          className="context-inspector-close"
          aria-label={t("common.close")}
          onClick={() => {
            closeInspector();
            triggerRef.current?.focus();
          }}
        >
          ×
        </button>
      </header>
      <div className="context-inspector-heading">
        <strong className="context-inspector-heading-value">
          {display.display === "used"
            ? t("chat.usageContextSpent", {
                count: formatCompactTokenCount(display.tokens),
              })
            : t("chat.usageContextLeft", {
                count: formatCompactTokenCount(display.tokens),
              })}
        </strong>
        <strong className="context-inspector-heading-percent">
          {display.percent}%
        </strong>
      </div>
      <ContextUsageDashboard
        key={sessionId}
        usage={usage}
        contextWindow={contextWindow}
        messages={sessionMessages}
        compactions={compactions ?? EMPTY_COMPACTIONS}
        partial={sessionHistory?.hasMoreBefore === true}
        timing={sessionTiming}
        throughputLabel={
          throughput === undefined
            ? t("chat.usageThroughputUnavailable")
            : t(
                responseOutputEstimated
                  ? "chat.usageThroughputEstimated"
                  : "chat.usageThroughput",
                { count: formatCompactTokenCount(throughput) },
              )
        }
        timingValues={{
          network: networkRequestValue,
          model: modelResponseValue,
          tools: toolCallValue,
        }}
        turnTools={tools}
      />
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
        ? portalToBody(popover)
        : null}
    </div>
  );
}
