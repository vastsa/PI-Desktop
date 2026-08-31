import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  ContextCompactionMark,
  MessageUsage,
  PlanningState,
  ProposalKind,
  UiMessage,
} from "@pi-desktop/shared";
import { proposalKindForMode } from "@pi-desktop/shared";
import { ConversationMinimap } from "./ConversationMinimap";
import { TurnOutcomeCard } from "./TurnOutcomeCard";
import { ReviewChangeCard } from "./ReviewChangeCard";
import { Markdown, useCopy } from "./Markdown";
import { ToolChips, ToolDetailBlocks } from "./ToolDetails";
import {
  formatToolDuration,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryValue,
  type ToolAction,
} from "../lib/tool-display";
import {
  buildToolPresentation,
  hasToolDetails,
  runOutcome,
  toolResultPayload,
  toolResultChips,
} from "../lib/tool-presentation";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  isDelegationActivityItem,
  lifecycleKindOf,
  subagentOutcome,
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../lib/subagent-topology";
import { useOpenPreviewTarget } from "../lib/use-preview-target";
import {
  getToolPreviewTarget,
  splitChatText,
} from "../lib/chat-links";
import {
  isRecentScrollGesture,
  reduceTranscriptScroll,
} from "../lib/transcript-scroll";
import {
  growTranscriptWindow,
  reduceTranscriptWindow,
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
} from "../lib/transcript-window";
import {
  assistantTurnContent,
  assistantTurnMessages,
  assistantTurnResponseDuration,
  assistantTurnResponseOutputIsEstimated,
  assistantTurnResponseOutputTokens,
  assistantTurnTools,
  assistantTurnUsage,
  buildTranscriptEntries,
  messageThinking as thinkingText,
  subagentRunsEqual,
  transcriptEntryMessages,
  type AssistantActivityItem,
  type AssistantTurnEntry,
  type SubagentRun,
  type TranscriptEntry,
} from "../lib/assistant-turns";
import {
  aggregateToolTokenUsage,
  calculateCacheRate,
  calculateContextUsage,
  calculateTokenRate,
  DEFAULT_CONTEXT_WINDOW,
  latestMessageUsage,
  resolveContextWindow,
  usageTokenTotal,
} from "../lib/context-usage";
import {
  IconArrowDown,
  IconBot,
  IconBranch,
  IconCheck,
  IconCircleAlert,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconImage,
  IconListChecks,
  IconPencil,
  IconSearch,
  IconReview,
  IconSparkles,
  IconStop,
  IconTarget,
  IconTerminal,
  IconTrash,
  IconWorkflow,
  IconWrench,
} from "./icons";
import { useAppStore } from "../stores/app-store";
import type { PendingPermission } from "../lib/pending-permissions";
import { PermissionCard } from "./PermissionCard";

/**
 * Copy chip. Message toolbars are glyph-only (`icon`) with the label in a
 * hover tooltip; surfaces that need a worded button (error details) pass
 * `withLabel`.
 */
function CopyButton({
  text,
  label,
  withLabel = false,
}: {
  text: string;
  label: string;
  withLabel?: boolean;
}) {
  const { copied, copy } = useCopy();
  const { t } = useTranslation();
  const tip = copied ? t("chat.copied") : label;
  return (
    <button
      className={`copy-btn ${withLabel ? "" : "icon"} ${copied ? "copied" : ""}`}
      data-tip={withLabel ? undefined : tip}
      title={withLabel ? tip : undefined}
      aria-label={label}
      onClick={() => copy(text)}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {withLabel ? <span>{tip}</span> : null}
    </button>
  );
}


function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

const CONTEXT_RING_RADIUS = 9;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
const CONTEXT_POPOVER_GAP = 8;
const CONTEXT_VIEWPORT_MARGIN = 16;

type ContextPopoverPosition = {
  top: number;
  left: number;
};

function ContextUsageInspector({
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
    useState<ContextPopoverPosition | null>(null);
  const context = calculateContextUsage(usage, contextWindow);
  const turnTotal = usageTokenTotal(turnUsage);
  const throughput = calculateTokenRate(
    responseOutputTokens ?? turnUsage.outputTokens,
    responseDurationMs,
  );
  const cacheRate = calculateCacheRate(
    turnUsage.inputTokens,
    turnUsage.cacheReadTokens,
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
    const maxLeft = Math.max(
      CONTEXT_VIEWPORT_MARGIN,
      window.innerWidth - popoverRect.width - CONTEXT_VIEWPORT_MARGIN,
    );
    const left = Math.min(
      Math.max(CONTEXT_VIEWPORT_MARGIN, triggerRect.left),
      maxLeft,
    );
    const above = triggerRect.top - popoverRect.height - CONTEXT_POPOVER_GAP;
    const below = triggerRect.bottom + CONTEXT_POPOVER_GAP;
    const maxTop = Math.max(
      CONTEXT_VIEWPORT_MARGIN,
      window.innerHeight - popoverRect.height - CONTEXT_VIEWPORT_MARGIN,
    );
    const top =
      above >= CONTEXT_VIEWPORT_MARGIN && above <= maxTop
        ? above
        : below >= CONTEXT_VIEWPORT_MARGIN && below <= maxTop
          ? below
          : Math.min(Math.max(CONTEXT_VIEWPORT_MARGIN, below), maxTop);

    setPopoverPosition((previous) =>
      previous?.top === top && previous.left === left
        ? previous
        : { top, left },
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
            }
          : undefined
      }
    >
      <div className="context-inspector-heading">
        <div className="context-inspector-heading-copy">
          <span className="context-inspector-eyebrow">
            {t("chat.usageContextLabel")}
          </span>
          <strong>
            {t("chat.usageContextLeft", {
              count: formatTokenCount(context.remainingTokens),
            })}
          </strong>
        </div>
        <div className="context-inspector-remaining">
          <strong>{context.remainingPercent}%</strong>
          <span>{t("chat.usageContextRemaining")}</span>
        </div>
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
              {t("chat.usageInput")} {formatTokenCount(turnUsage.inputTokens)}
            </span>
            <span>
              {t("chat.usageOutput")} {formatTokenCount(turnUsage.outputTokens)}
            </span>
            {turnUsage.cacheReadTokens !== undefined ? (
              <span>
                {t("chat.usageCacheRead")} {formatTokenCount(turnUsage.cacheReadTokens)}
              </span>
            ) : null}
            {cacheRate !== undefined ? (
              <span>
                {t("chat.usageCacheRate")} {cacheRate}%
              </span>
            ) : null}
            {turnUsage.cacheWriteTokens !== undefined ? (
              <span>
                {t("chat.usageCacheWrite")} {formatTokenCount(turnUsage.cacheWriteTokens)}
              </span>
            ) : null}
            {turnUsage.reasoningTokens !== undefined ? (
              <span>
                {t("chat.usageReasoning")} {formatTokenCount(turnUsage.reasoningTokens)}
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
      <button
        ref={triggerRef}
        type="button"
        className="context-inspector-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t("chat.usageContextAria", {
          percent: context.remainingPercent,
          remaining: formatTokenCount(context.remainingTokens),
        })}
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
              CONTEXT_RING_CIRCUMFERENCE * (1 - context.remainingRatio)
            }
          />
        </svg>
        <span className="context-inspector-trigger-copy">
          <span>{t("chat.usageContextLabel")}</span>
          <strong>{context.remainingPercent}%</strong>
        </span>
      </button>
      {popover && typeof document !== "undefined"
        ? createPortal(popover, document.body)
        : null}
    </div>
  );
}

function MessageMeta({
  modelId,
  usage,
  contextUsage,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  tools = [],
  responseDurationMs,
  responseOutputTokens,
  responseOutputEstimated,
}: {
  modelId?: string;
  usage?: MessageUsage;
  contextUsage?: MessageUsage;
  contextWindow?: number;
  tools?: UiMessage[];
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated?: boolean;
}) {
  const { t } = useTranslation();
  const visibleContextUsage = contextUsage ?? usage;
  const throughput = calculateTokenRate(
    responseOutputTokens ?? usage?.outputTokens ?? 0,
    responseDurationMs,
  );
  if (!modelId && !usage && !visibleContextUsage && throughput === undefined) {
    return null;
  }
  return (
    <div className="message-meta">
      {modelId ? (
        <span className="message-meta-chip model" title={modelId}>
          {modelId}
        </span>
      ) : null}
      {visibleContextUsage ? (
        <ContextUsageInspector
          usage={visibleContextUsage}
          turnUsage={usage ?? visibleContextUsage}
          contextWindow={contextWindow}
          tools={tools}
          responseDurationMs={responseDurationMs}
          responseOutputTokens={responseOutputTokens}
          responseOutputEstimated={responseOutputEstimated}
        />
      ) : null}
      {!visibleContextUsage && throughput !== undefined ? (
        <span className="message-meta-chip throughput">
          {t("chat.usageThroughputEstimated", {
            count: formatTokenCount(throughput),
          })}
        </span>
      ) : null}
    </div>
  );
}

function AssistantErrorMessage({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const detailsId = useId();
  const error = message.error;
  if (!error) return null;
  const localizedKey = `errors.${error.code}`;
  const localized = t(localizedKey);
  const summary = localized === localizedKey ? t("chat.responseFailed") : localized;
  const configurationError = [
    "MODEL_NOT_CONFIGURED",
    "PROVIDER_SECRET_MISSING",
    "PROVIDER_UNAUTHORIZED",
  ].includes(error.code);

  return (
    <section className="message-error" aria-label={t("chat.responseError")}>
      <div className="message-error-heading">
        <span className="message-error-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="message-error-copy">
          <strong>{summary}</strong>
          <code>{error.code}</code>
        </div>
        <div className="message-error-actions">
          <button
            type="button"
            className="message-error-toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
          >
            <IconChevronRight size={12} aria-hidden />
            {open ? t("chat.hideErrorDetails") : t("chat.showErrorDetails")}
          </button>
          {configurationError ? (
            <button
              type="button"
              className="copy-btn"
              onClick={() => {
                useAppStore.getState().setSettingsTab("agent");
                useAppStore.getState().setPage("settings");
              }}
            >
              {t("errors.action.openSettings")}
            </button>
          ) : null}
        </div>
      </div>
      <div
        id={detailsId}
        className={`message-error-details ${open ? "open" : ""}`}
        hidden={!open}
      >
        <dl>
          {message.providerId ? (
            <>
              <dt>{t("chat.errorProvider")}</dt>
              <dd>{message.providerId}</dd>
            </>
          ) : null}
          {message.modelId ? (
            <>
              <dt>{t("chat.errorModel")}</dt>
              <dd>{message.modelId}</dd>
            </>
          ) : null}
        </dl>
        <div className="message-error-raw">
          <pre className="selectable">{error.message}</pre>
          <CopyButton text={error.message} label={t("chat.copyErrorDetails")} />
        </div>
      </div>
    </section>
  );
}

const TOOL_ACTION_KEYS: Record<ToolAction, string> = {
  read: "chat.toolRead",
  list: "chat.toolListed",
  search: "chat.toolSearched",
  write: "chat.toolWrote",
  edit: "chat.toolEdited",
  run: "chat.toolRan",
  fetch: "chat.toolFetched",
  fork: "chat.toolUsed",
  delegate: "chat.toolDelegated",
  use: "chat.toolUsed",
};

/**
 * A lifecycle row says what it did to subagents, not that it "delegated":
 * `Task` is the only call that delegates (ADR 0062, ADR 0089, D268).
 */
const LIFECYCLE_LABEL_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaited",
  list: "chat.subagentListed",
  stop: "chat.subagentStopped",
};

/** A wait in progress is the one lifecycle row that visibly takes time. */
const LIFECYCLE_RUNNING_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaiting",
  list: "chat.subagentListing",
  stop: "chat.subagentStopping",
};

const TOOL_RUNNING_KEYS: Record<ToolAction, string> = {
  read: "chat.toolReading",
  list: "chat.toolListing",
  search: "chat.toolSearching",
  write: "chat.toolWriting",
  edit: "chat.toolEditing",
  run: "chat.toolRunning",
  fetch: "chat.toolFetching",
  fork: "chat.toolUsing",
  delegate: "chat.toolDelegating",
  use: "chat.toolUsing",
};

function ToolActionIcon({ action }: { action: ToolAction }) {
  const props = { size: 15, "aria-hidden": true };
  switch (action) {
    case "read":
      return <IconFileText {...props} />;
    case "list":
      return <IconFolder {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "write":
    case "edit":
      return <IconPencil {...props} />;
    case "run":
      return <IconTerminal {...props} />;
    case "fetch":
      return <IconGlobe {...props} />;
    case "fork":
      return <IconBranch {...props} />;
    case "delegate":
      return <IconBot {...props} />;
    default:
      return <IconWrench {...props} />;
  }
}

/** Actions whose path/url argument makes sense to preview in the panel. */
const PREVIEWABLE_ACTIONS = new Set<ToolAction>(["read", "write", "edit", "fetch"]);

/** Plain user text with file paths and URLs linkified to the work panel. */
function LinkifiedText({ text }: { text: string }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const segments = useMemo(() => splitChatText(text, root), [text, root]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <button
            key={index}
            type="button"
            className="chat-text-link"
            title={
              segment.target.kind === "file"
                ? t("chat.previewFile")
                : t("chat.previewUrl")
            }
            onClick={() => openTarget(segment.target)}
          >
            {segment.text}
          </button>
        ),
      )}
    </>
  );
}

/** Definition name a `Task` row delegated to, from the rows it produced or,
 * before any arrived, from the call's own argument. */
function delegateAgentName(
  message: UiMessage,
  delegate?: SubagentRun,
): string {
  if (delegate?.agentName) return delegate.agentName;
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const requested = (args as { agent?: unknown }).agent;
    if (typeof requested === "string") return requested;
  }
  return "";
}

/**
 * Copies a run row's command from its head. The expanded body holds only the
 * output, so this is the one place the command can be taken from (D226).
 */
function ToolCommandCopy({ command }: { command: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <button
      className={`tool-row-head-copy${copied ? " copied" : ""}`}
      aria-label={`${t("chat.copy")} ${t("chat.toolBlockCommand")}`}
      title={copied ? t("chat.copied") : t("chat.copy")}
      onClick={() => copy(command)}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

function ToolRow({
  message,
  delegate,
  variant = "default",
  delegationStatuses,
  delegationTimings,
}: {
  message: UiMessage;
  /** Rows the delegate produced, when this row is a `Task` call (ADR 0062). */
  delegate?: SubagentRun;
  /** Card treatment used when several Task calls form a delegation topology. */
  variant?: "default" | "topology";
  /** Live delegation statuses read from the turn's lifecycle-tool rows. */
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Runtime timings read from the turn's delegation lifecycle rows. */
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const status = message.toolStatus;
  const action = getToolAction(message.toolName);
  // A run row states what the command did, not what the call around it did: an
  // exit code the shell reported outranks a tool call that came back fine
  // (D227). Property reads only, so a streaming row can afford it every tick.
  const run = action === "run" ? runOutcome(message) : null;
  const failed = status === "error" || run === "failed";
  const [open, setOpen] = useState(failed);
  const actionLabel = t(
    status === "running" ? TOOL_RUNNING_KEYS[action] : TOOL_ACTION_KEYS[action],
  );
  const rawName = getToolDisplayName(message.toolName) || t("chat.tool");
  const argSummary = getToolSummary(message.toolName, message.toolArgs);
  const previewTarget = PREVIEWABLE_ACTIONS.has(action)
    ? getToolPreviewTarget(message.toolArgs, root)
    : null;
  // A run row keeps its command in the head and only its output in the body, so
  // the head carries the two things the body no longer offers: a copy of the
  // command, and the outcome (D226).
  const runHead = action === "run" && variant !== "topology";
  const command = runHead
    ? getToolSummaryValue(message.toolName, message.toolArgs)
    : "";
  // A delegation is always expandable: its brief, report and the delegate's
  // own rows all live in the body.
  const hasDetails = hasToolDetails(message) || Boolean(delegate);
  const chips = toolResultChips(message);
  // A lifecycle row (ADR 0089) is about subagents, so it is presented as one:
  // the agent names it reports on replace the bare delegation ids it was
  // called with, and its badge rolls up their statuses (D268).
  const lifecycle = action === "delegate" ? lifecycleKindOf(message) : null;
  const roster = lifecycle ? delegationRoster(message) : [];
  const rosterSummary = lifecycle ? delegationRosterSummary(roster) : "";
  const rosterOutcome = lifecycle ? delegationRosterOutcome(roster) : null;
  const agentName =
    action === "delegate" && !lifecycle
      ? delegateAgentName(message, delegate)
      : "";
  // The delegate's last answer row is its report, so the body must not print
  // the same text a second time.
  const nestedReport = delegate?.items.some((item) => item.kind === "answer");
  // Streaming updates replace the message object each tick; only pay the
  // full payload walk once the row is actually expanded.
  const blocks =
    open && hasDetails
      ? buildToolPresentation(message, {
          hideSummaryArg: true,
          ...(nestedReport ? { hideDelegateReport: true } : {}),
        })
      : null;
  const outcome =
    variant === "topology" ? subagentOutcome(message, delegationStatuses) : null;
  const runLabel =
    run === "running"
      ? t("chat.running")
      : run === "failed"
        ? t("chat.toolFailed")
        : run === "denied"
          ? t("chat.toolDenied")
          : run === "ok"
            ? t("chat.toolCompleted")
            : "";
  // A lifecycle row never falls back to its arguments: while it is still
  // running it has no roster yet, and `delegationIds` would otherwise reach the
  // head as a JSON blob of UUIDs (D268).
  const summary = lifecycle ? rosterSummary : argSummary;
  const statusLabel = outcome
    ? t(`chat.subagentStatus.${outcome}`)
    : rosterOutcome
      ? t(`chat.subagentStatus.${rosterOutcome}`)
      : run
      ? runLabel
      : status === "running"
        ? t("chat.running")
        : status === "error"
          ? t("chat.toolFailed")
          : status === "denied"
            ? t("chat.toolDenied")
            : t("chat.toolCompleted");
  const delegationPayload =
    variant === "topology" ? toolResultPayload(message) : undefined;
  const delegationId =
    delegationPayload && typeof delegationPayload === "object"
      ? (delegationPayload as { delegationId?: unknown }).delegationId
      : undefined;
  const delegationTiming =
    typeof delegationId === "string"
      ? delegationTimings?.get(delegationId)
      : undefined;
  const [now, setNow] = useState(Date.now);
  const durationMs =
    delegationTiming?.startedAt !== undefined
      ? Math.max(
          0,
          (delegationTiming.completedAt ??
            (outcome === "running" ? now : delegationTiming.startedAt)) -
            delegationTiming.startedAt,
        )
      : message.toolDurationMs;
  const duration =
    typeof durationMs === "number" && durationMs > 0
      ? formatToolDuration(durationMs / 1000)
      : "";

  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  useEffect(() => {
    if (outcome === "failed") setOpen(true);
  }, [outcome]);

  useEffect(() => {
    if (outcome !== "running") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [outcome]);

  const statusTone =
    run === "running" || (!run && status === "running")
      ? "is-running"
      : failed
        ? "is-error"
        : run === "denied" || (!run && status === "denied")
          ? "is-denied"
          : "is-done";
  const caret = hasDetails ? <IconChevronRight size={12} /> : null;

  return (
    <div
      className={`tool-row ${variant === "topology" ? "subagent-topology-node" : ""} ${
        open ? "open" : ""
      } status-${run === "failed" ? "error" : status || "success"}${outcome ? ` outcome-${outcome.replaceAll("_", "-")}` : ""}`}
      role={variant === "topology" ? "listitem" : "region"}
      aria-label={`${t("chat.toolCall")}: ${rawName}${statusLabel ? `, ${statusLabel}` : ""}`}
    >
      {variant === "topology" ? (
        <button
          className="subagent-topology-node-header"
          aria-expanded={open}
          aria-controls={hasDetails ? detailsId : undefined}
          disabled={!hasDetails}
          title={summary || agentName || rawName}
          onClick={() => hasDetails && setOpen((value) => !value)}
        >
          <span className="subagent-topology-avatar" aria-hidden>
            <IconBot size={15} />
            <span className="subagent-topology-status-icon">
              {outcome === "completed" ? (
                <IconCheck size={8} />
              ) : outcome === "aborted" ? (
                <IconStop size={7} />
              ) : outcome === "running" ? (
                <span />
              ) : (
                <IconCircleAlert size={8} />
              )}
            </span>
          </span>
          <span className="subagent-topology-node-copy">
            <span className="subagent-topology-node-title-row">
              <span className="subagent-topology-node-title">
                {agentName || t("chat.subagentUnnamed")}
              </span>
              <span className="subagent-topology-node-status">
                {statusLabel}
                {duration ? ` · ${duration}` : ""}
              </span>
            </span>
            {summary ? (
              <span className="subagent-topology-node-summary">{summary}</span>
            ) : null}
            {delegate?.items.length ? (
              <span className="subagent-topology-node-steps">
                {t("chat.processingSteps", { count: delegate.items.length })}
              </span>
            ) : null}
          </span>
          {outcome === "running" ? (
            <span className="tool-spinner" aria-label={t("chat.running")} />
          ) : null}
          {hasDetails ? (
            <span className="tool-row-caret" aria-hidden>
              <IconChevronRight size={12} />
            </span>
          ) : null}
        </button>
      ) : (
        <div className={`tool-row-head${runHead ? " is-run" : ""}`}>
          <button
            className="tool-row-header"
            aria-expanded={open}
            aria-controls={hasDetails ? detailsId : undefined}
            disabled={!hasDetails}
            title={summary || rawName}
            onClick={() => hasDetails && setOpen((value) => !value)}
          >
            <span
              className={`tool-row-icon${lifecycle ? " is-subagent" : ""}`}
            >
              <ToolActionIcon action={action} />
            </span>
            <span
              className={`tool-row-name ${status === "running" ? "running" : ""}`}
            >
              {lifecycle
                ? t(
                    (status === "running"
                      ? LIFECYCLE_RUNNING_KEYS
                      : LIFECYCLE_LABEL_KEYS)[lifecycle],
                  )
                : actionLabel}
            </span>
            {lifecycle && roster.length > 0 ? (
              <span className="tool-row-agent is-count">
                {t("chat.subagentCount", { count: roster.length })}
              </span>
            ) : null}
            {agentName ? (
              <span className="tool-row-agent" title={t("chat.subagentAgent")}>
                {agentName}
              </span>
            ) : null}
            {summary ? (
              <span
                className={`tool-row-summary${previewTarget ? " linked" : ""}`}
                title={
                  previewTarget
                    ? previewTarget.kind === "file"
                      ? t("chat.previewFile")
                      : t("chat.previewUrl")
                    : undefined
                }
                onClick={
                  previewTarget
                    ? (e) => {
                        // Open the preview target instead of toggling details.
                        e.stopPropagation();
                        openTarget(previewTarget);
                      }
                    : undefined
                }
              >
                {summary}
              </span>
            ) : null}
            <ToolChips chips={chips} />
            {runHead && statusLabel ? (
              <span
                className={`tool-row-state ${statusTone}`}
                role="status"
                aria-live="polite"
              >
                <span className="tool-row-state-dot" aria-hidden />
                {statusLabel}
              </span>
            ) : status === "running" ? (
              <span className="tool-spinner" aria-label={t("chat.running")} />
            ) : status === "error" ? (
              <span
                className="tool-row-status error"
                aria-label={t("chat.toolFailed")}
              >
                <IconCircleAlert size={13} />
                {t("chat.toolFailed")}
              </span>
            ) : status === "denied" ? (
              <span className="tool-row-status">{t("chat.toolDenied")}</span>
            ) : null}
            {runHead && statusLabel ? null : (
              <span className="sr-only" role="status" aria-live="polite">
                {statusLabel}
              </span>
            )}
            {runHead || !caret ? null : (
              <span className="tool-row-caret" aria-hidden>
                {caret}
              </span>
            )}
          </button>
          {runHead && command ? <ToolCommandCopy command={command} /> : null}
          {runHead && caret ? (
            // Redundant for the keyboard — the header itself is the disclosure —
            // so it is a pointer target only and stays out of the reading order.
            <button
              className="tool-row-caret is-toggle"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setOpen((value) => !value)}
            >
              {caret}
            </button>
          ) : null}
        </div>
      )}
      {variant === "topology" ? (
        <span className="sr-only" role="status" aria-live="polite">
          {statusLabel}
        </span>
      ) : null}
      {blocks && blocks.length > 0 ? (
        <div className="tool-row-body" id={detailsId}>
          <DisclosureCollapseRail
            label={t("chat.collapseDetails")}
            onCollapse={() => setOpen(false)}
          />
          <ToolDetailBlocks blocks={blocks} plain={runHead} />
        </div>
      ) : null}
      {open && delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          onCollapse={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * What a delegate did, nested under the `Task` call that spawned it.
 *
 * The rows are the delegate's context, not the parent's, so they are visibly
 * one level in and stay collapsed with the call. Only one level is possible: a
 * delegate has no `Task` tool of its own (ADR 0062).
 */
function SubagentRunRows({
  run,
  agentName,
  onCollapse,
}: {
  run: SubagentRun;
  agentName: string;
  onCollapse: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (run.items.length === 0) return null;
  return (
    <div className="subagent-run">
      <DisclosureCollapseRail
        label={t("chat.collapseDetails")}
        onCollapse={onCollapse}
      />
      <div className="subagent-run-heading" id={headingId}>
        <IconBot size={13} aria-hidden />
        <span>
          {agentName
            ? t("chat.subagentWork", { agent: agentName })
            : t("chat.subagentWorkUnnamed")}
        </span>
        <span className="subagent-run-count">
          {t("chat.processingSteps", { count: run.items.length })}
        </span>
      </div>
      {/* The rows scroll inside the run rather than growing the transcript
        * (D271). Labelled and focusable so a keyboard reader can reach the
        * scroll area the pointer can already use. */}
      <div
        className="subagent-run-rows"
        role="group"
        tabIndex={0}
        aria-labelledby={headingId}
      >
        {run.items.map((item) =>
          item.kind === "tool" ? (
            <Fragment key={item.message.id}>
              <ToolRow message={item.message} />
              <ReviewChangeCard message={item.message} />
            </Fragment>
          ) : item.kind === "thinking" ? (
            <ThinkingRow
              key={`thinking-${item.message.id}`}
              message={item.message}
              streaming={item.message.status === "streaming"}
            />
          ) : (
            <div className="subagent-answer" key={`answer-${item.message.id}`}>
              {item.message.content ? (
                <div className="prose-chat">
                  <Markdown source={item.message.content} />
                </div>
              ) : null}
              {item.message.error ? (
                <AssistantErrorMessage message={item.message} />
              ) : null}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A truthful one-level graph of one parent fan-out (ADR 0062).
 *
 * The runtime has no delegate-to-delegate edges, so this deliberately stops at
 * main agent -> Task nodes instead of implying dependencies that do not exist.
 */
function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const summary = summarizeSubagentActivity(items, delegationStatuses);

  return (
    <section className="subagent-topology" aria-labelledby={labelId}>
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <IconTarget size={16} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{t("chat.subagentCoordinator")}</strong>
          <span>
            {t("chat.subagentCoordinating", { count: summary.total })}
          </span>
        </span>
      </div>
      <span className="subagent-topology-connector" aria-hidden />
      <div
        className="subagent-topology-agents"
        role="list"
        aria-label={t("chat.subagentTopology")}
      >
        {items.map((item) => (
          <ToolRow
            key={item.message.id}
            message={item.message}
            {...(item.delegate ? { delegate: item.delegate } : {})}
            variant="topology"
            {...(delegationStatuses ? { delegationStatuses } : {})}
            {...(delegationTimings ? { delegationTimings } : {})}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One item on the activity timeline between two answers: either a thinking
 * segment (an assistant message's reasoning) or a tool call. Grouping both
 * into a single disclosure keeps long agent loops from stacking alternating
 * "Thinking" / "Processed" rows down the transcript.
 */
type ActivityItem = AssistantActivityItem;

function activityItemSummary(
  item: ActivityItem,
  t: (key: string) => string,
): string {
  if (item.kind === "thinking") {
    // Latest thought line, so the collapsed header reads like a live ticker.
    const lines = thinkingText(item.message)
      .split("\n")
      .map((line) => line.replace(/^#+\s*|\*\*/g, "").trim())
      .filter(Boolean);
    return lines[lines.length - 1] || "";
  }
  const message = item.message;
  const action = getToolAction(message.toolName);
  const actionLabel = t(
    message.toolStatus === "running"
      ? TOOL_RUNNING_KEYS[action]
      : TOOL_ACTION_KEYS[action],
  );
  const summary = getToolSummary(message.toolName, message.toolArgs);
  return summary ? `${actionLabel} ${summary}` : actionLabel;
}

function DisclosureCollapseRail({
  label,
  onCollapse,
}: {
  label: string;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      className="disclosure-collapse-rail"
      aria-label={label}
      title={label}
      onClick={onCollapse}
    />
  );
}

/** A thinking segment rendered like a tool row: one-line summary, expandable. */
function ThinkingRow({
  message,
  streaming,
}: {
  message: UiMessage;
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const text = thinkingText(message);
  const summary = text.replace(/\s+/g, " ").trim();
  return (
    <div className={`tool-row thinking ${open ? "open" : ""}`}>
      <button
        className="tool-row-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={t(open ? "chat.thinkingHide" : "chat.thinkingShow")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-row-icon">
          <IconSparkles size={15} aria-hidden />
        </span>
        <span className={`tool-row-name ${streaming ? "running" : ""}`}>
          {t("chat.thinking", { defaultValue: "Thinking" })}
        </span>
        <span className="tool-row-summary">{summary}</span>
        <span className="tool-row-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      {open ? (
        <div className="tool-row-body" id={detailsId}>
          <DisclosureCollapseRail
            label={t("chat.thinkingHide")}
            onCollapse={() => setOpen(false)}
          />
          <div className="prose-chat thinking-prose">
            <Markdown source={text} renderDiagrams={false} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ActivityGroupProps = {
  items: ActivityItem[];
  isActive: boolean;
  endedAt?: string;
  /** Delegation statuses from the entire assistant turn (cross-activity-part). */
  turnDelegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Delegation timings from the entire assistant turn (cross-activity-part). */
  turnDelegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

/** Whether two activity items render identically, delegate rows included. */
function activityItemsEqual(
  previous: ActivityItem,
  next: ActivityItem,
): boolean {
  if (previous.kind !== next.kind || previous.message !== next.message) {
    return false;
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    return subagentRunsEqual(previous.delegate, next.delegate);
  }
  return true;
}

function activityGroupPropsEqual(
  previous: ActivityGroupProps,
  next: ActivityGroupProps,
) {
  if (
    previous.isActive !== next.isActive ||
    previous.endedAt !== next.endedAt ||
    previous.items.length !== next.items.length ||
    previous.turnDelegationStatuses !== next.turnDelegationStatuses ||
    previous.turnDelegationTimings !== next.turnDelegationTimings
  ) {
    return false;
  }
  return previous.items.every((item, index) =>
    activityItemsEqual(item, next.items[index]),
  );
}

const ActivityGroup = memo(function ActivityGroup({
  items,
  isActive,
  endedAt,
  turnDelegationStatuses,
  turnDelegationTimings,
}: ActivityGroupProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const delegateItems = items.filter(isDelegationActivityItem);
  // One delegation reads the same as five: the card is how a delegation is
  // presented, not a treatment reserved for fan-out. A lone `Task` rendered as
  // an ordinary tool row hid the outcome, runtime and step count that the card
  // states outright, and made the same work look like two different features.
  const hasSubagentTopology = delegateItems.length > 0;
  // `Task` rows only ever say "running"; the turn's TaskWait/TaskList/TaskStop
  // rows carry how each delegate actually ended (ADR 0089). When the lifecycle
  // tool is in a different activity part (the agent emitted text between Task
  // and TaskWait), the turn-level statuses computed by the parent give us the
  // cross-part view we need.
  const delegationStatuses = turnDelegationStatuses ?? collectDelegationStatuses(items);
  const delegationTimings =
    turnDelegationTimings ?? collectDelegationTimings(items);
  const subagentSummary = summarizeSubagentActivity(
    delegateItems,
    delegationStatuses,
  );
  const [open, setOpen] = useState(isActive && hasSubagentTopology);
  const [now, setNow] = useState(Date.now);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const wasActiveRef = useRef(isActive);
  const topologyAutoOpenedRef = useRef(isActive && hasSubagentTopology);
  const messages = items.map((item) => item.message);
  const startedAt = Date.parse(messages[0]?.createdAt || "") || now;
  const fallbackEnd =
    Math.max(
      startedAt,
      ...messages.map(
        (message) =>
          Date.parse(message.toolCompletedAt || "") ||
          (Date.parse(message.createdAt) || startedAt) +
            (message.toolDurationMs || 0),
      ),
    );
  const completedAt =
    Date.parse(endedAt || "") ||
    finishedAt ||
    (wasActiveRef.current ? now : fallbackEnd);
  const elapsedSeconds = Math.max(
    0,
    Math.floor(((isActive ? now : completedAt) - startedAt) / 1000),
  );
  const elapsed = formatToolDuration(elapsedSeconds);
  const lastItem = items[items.length - 1];
  const thinkingNow =
    isActive &&
    lastItem?.kind === "thinking" &&
    lastItem.message.status === "streaming";
  const onlyThinking = items.every((item) => item.kind === "thinking");
  const label = hasSubagentTopology
    ? t(
        isActive || subagentSummary.running > 0
          ? "chat.subagentsWorking"
          : subagentSummary.issues > 0
            ? "chat.subagentsFinishedWithIssues"
            : subagentSummary.warnings > 0
              ? "chat.subagentsFinishedWithWarnings"
              : "chat.subagentsFinished",
        // A card is now drawn for a lone delegation too, so the aggregate line
        // has to be able to say "Subagent working" and not only the plural.
        { count: subagentSummary.total },
      )
    : isActive
      ? t(thinkingNow || onlyThinking ? "chat.thinkingFor" : "chat.processingFor", {
          time: elapsed,
        })
      : onlyThinking
        ? elapsedSeconds > 0
          ? t("chat.thoughtFor", { time: elapsed })
          : // History reloads keep no end timestamp for pure-thinking groups.
            t("chat.thinking", { defaultValue: "Thinking" })
        : t("chat.processedFor", { time: elapsed });
  const tail = isActive && !open && lastItem ? activityItemSummary(lastItem, t) : "";

  useEffect(() => {
    if (wasActiveRef.current && !isActive) setFinishedAt(Date.now());
    wasActiveRef.current = isActive;
    if (!isActive) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !hasSubagentTopology || topologyAutoOpenedRef.current) return;
    topologyAutoOpenedRef.current = true;
    setOpen(true);
  }, [hasSubagentTopology, isActive]);

  const renderActivityItems = () => {
    let renderedTopology = false;
    return items.map((item) => {
      if (hasSubagentTopology && isDelegationActivityItem(item)) {
        if (renderedTopology) return null;
        renderedTopology = true;
        return (
          <SubagentTopology
            key="subagent-topology"
            items={delegateItems}
            delegationStatuses={delegationStatuses}
            delegationTimings={delegationTimings}
          />
        );
      }
      return item.kind === "tool" ? (
        <Fragment key={item.message.id}>
          <ToolRow
            message={item.message}
            {...(item.delegate ? { delegate: item.delegate } : {})}
          />
          <ReviewChangeCard message={item.message} />
        </Fragment>
      ) : (
        <ThinkingRow
          key={`thinking-${item.message.id}`}
          message={item.message}
          streaming={isActive && item.message.status === "streaming"}
        />
      );
    });
  };

  return (
    <div
      className={`tool-activity-group ${hasSubagentTopology ? "has-subagents" : ""} ${
        open ? "open" : ""
      } ${
        isActive ? "active" : ""
      }`}
    >
      <button
        className="tool-activity-header"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-activity-icon" aria-hidden>
          {hasSubagentTopology ? (
            <IconWorkflow size={15} />
          ) : (
            <IconSparkles size={14} />
          )}
        </span>
        <span className={`tool-activity-label ${isActive ? "running" : ""}`}>
          {label}
        </span>
        {hasSubagentTopology ? (
          <span className="subagent-activity-metrics">
            {t("chat.subagentCount", { count: subagentSummary.total })}
            <span aria-hidden> · </span>
            {t("chat.subagentFinishedCount", {
              finished: subagentSummary.finished,
              total: subagentSummary.total,
            })}
            <span aria-hidden> · </span>
            {elapsed}
          </span>
        ) : items.length > 1 ? (
          <span className="tool-activity-count">
            {t("chat.processingSteps", { count: items.length })}
          </span>
        ) : null}
        <span className="tool-activity-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      {tail ? (
        <div className="tool-activity-preview" aria-hidden>
          {tail}
        </div>
      ) : null}
      <div
        className="tool-activity-collapse"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="tool-activity-collapse-inner">
          <div className="tool-activity-body" id={detailsId}>
            <DisclosureCollapseRail
              label={t("chat.collapseDetails")}
              onCollapse={() => setOpen(false)}
            />
            {renderActivityItems()}
          </div>
        </div>
      </div>
    </div>
  );
}, activityGroupPropsEqual);

/** Keep the transcript responsive while the model waits for its first event. */
function WorkingIndicator() {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    };
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="working-indicator"
      data-testid="working-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="shimmer-text">{t("chat.running")}</span>
      {elapsed > 0 ? (
        <span className="working-elapsed" aria-hidden="true">
          {formatToolDuration(elapsed)}
        </span>
      ) : null}
    </div>
  );
}

function PlanningIndicator({ kind }: { kind: ProposalKind }) {
  const { t } = useTranslation();
  return (
    <div
      className="planning-state-indicator"
      role="status"
      aria-live="polite"
      data-kind={kind}
    >
      {kind === "goal" ? (
        <IconTarget size={14} aria-hidden />
      ) : (
        <IconListChecks size={14} aria-hidden />
      )}
      <span>{t(`${kind}.planning`)}</span>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const isUser = message.role === "user";
  // Slash prompts are stored expanded; editing works on the typed form so the
  // resent turn re-expands the template (D123).
  const editSeed = (isUser && message.command) || message.content || "";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(editSeed);
  const [savingEdit, setSavingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = message.content || "";
  const hasAnswer = Boolean((message.content || "").trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = isUser && revisionCount > 1;
  const cancelEdit = () => {
    setEditValue(editSeed);
    setEditing(false);
  };
  const saveEdit = async () => {
    const next = editValue.trim();
    if (savingEdit || (!next && !message.attachments?.length)) return;
    // An unchanged prompt is not worth a regenerate branch.
    if (next === editSeed.trim()) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    const saved = await editUserMessage(message.id, next, message.attachments);
    setSavingEdit(false);
    if (saved) setEditing(false);
  };
  return (
    <div
      className={`message-row ${isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      role="article"
      aria-label={isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {isUser || displayed ? (
          <div className="message-bubble">
            {editing ? (
              <div className="message-edit">
                <textarea
                  className="message-edit-input selectable"
                  value={editValue}
                  rows={Math.min(12, Math.max(3, editValue.split("\n").length))}
                  aria-label={editLabel}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={savingEdit}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelEdit();
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void saveEdit();
                    }
                  }}
                />
                <div className="message-edit-actions">
                  <button
                    type="button"
                    className="copy-btn"
                    disabled={savingEdit}
                    onClick={cancelEdit}
                  >
                    {t("chat.cancelEdit")}
                  </button>
                  <button
                    type="button"
                    className="copy-btn primary"
                    disabled={savingEdit || (!editValue.trim() && !message.attachments?.length)}
                    onClick={() => void saveEdit()}
                  >
                    {savingEdit ? t("chat.savingEdit") : t("chat.saveEdit")}
                  </button>
                </div>
              </div>
            ) : isUser ? (
              <>
                {message.attachments?.length ? (
                  <div
                    className="message-attachments"
                    role="list"
                    aria-label={t("chat.messageAttachments")}
                  >
                    {message.attachments.map((attachment) => (
                      <div
                        key={`${attachment.ref}:${attachment.name}`}
                        className="message-attachment"
                        role="listitem"
                        title={attachment.ref}
                      >
                        {attachment.kind === "image" ? (
                          <IconImage size={13} aria-hidden />
                        ) : (
                          <IconFileText size={13} aria-hidden />
                        )}
                        <span>{attachment.name}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {message.content ? (
                  <div className="message-user-text selectable">
                    {message.command ? (
                      // Slash invocations show the typed form as a chip; the
                      // expanded template body lives in `content` (hover reveals
                      // it) and is what regenerate/reseed replay (D123).
                      <code
                        className="chat-command-chip"
                        title={String(message.content || "")}
                      >
                        {message.command}
                      </code>
                    ) : (
                      <LinkifiedText text={String(message.content || "")} />
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="prose-chat">
                <Markdown source={displayed} />
              </div>
            )}
          </div>
        ) : null}
        {!editing && (hasAnswer || showRevisionPager) ? (
          <div className="message-actions">
            {showRevisionPager ? (
              <div className="message-revision-pager" role="group" aria-label={t("chat.revisions")}>
                <button
                  className="copy-btn icon revision-nav"
                  data-tip={t("chat.revisionPrev")}
                  aria-label={t("chat.revisionPrev")}
                  disabled={isRunning || activeRevision <= 1}
                  onClick={() =>
                    void activateMessageRevision(message.id, Math.max(1, activeRevision - 1))
                  }
                >
                  <IconChevronLeft size={13} />
                </button>
                <span className="message-revision-label">
                  {t("chat.revisionPager", {
                    current: activeRevision,
                    total: revisionCount,
                  })}
                </span>
                <button
                  className="copy-btn icon revision-nav"
                  data-tip={t("chat.revisionNext")}
                  aria-label={t("chat.revisionNext")}
                  disabled={isRunning || activeRevision >= revisionCount}
                  onClick={() =>
                    void activateMessageRevision(
                      message.id,
                      Math.min(revisionCount, activeRevision + 1),
                    )
                  }
                >
                  <IconChevronRight size={13} />
                </button>
              </div>
            ) : null}
            {hasAnswer ? <CopyButton text={message.content} label={copyLabel} /> : null}
            {isUser ? (
              <button
                className="copy-btn icon"
                data-tip={editLabel}
                aria-label={editLabel}
                disabled={isRunning}
                onClick={() => {
                  setEditValue(editSeed);
                  setEditing(true);
                }}
              >
                <IconPencil size={13} />
              </button>
            ) : null}
            {isUser ? (
              <button
                className="copy-btn icon danger"
                data-tip={deleteLabel}
                aria-label={deleteLabel}
                disabled={isRunning}
                onClick={() => void deleteMessage(message.id)}
              >
                <IconTrash size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  isActive: boolean;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (
    previous.isActive !== next.isActive ||
    previous.entry.anchorId !== next.entry.anchorId ||
    previous.entry.parts.length !== next.entry.parts.length
  ) {
    return false;
  }
  return previous.entry.parts.every((part, index) => {
    const nextPart = next.entry.parts[index];
    if (part.kind !== nextPart.kind) return false;
    if (part.kind === "message" && nextPart.kind === "message") {
      return part.message === nextPart.message;
    }
    if (part.kind === "activity" && nextPart.kind === "activity") {
      return (
        part.endedAt === nextPart.endedAt &&
        part.items.length === nextPart.items.length &&
        part.items.every((item, itemIndex) =>
          activityItemsEqual(item, nextPart.items[itemIndex]),
        )
      );
    }
    return false;
  });
}

function compactionMarksEqual(
  previous: ContextCompactionMark,
  next: ContextCompactionMark,
): boolean {
  return (
    previous.id === next.id &&
    previous.throughMessageId === next.throughMessageId &&
    previous.generation === next.generation &&
    previous.summaryTokens === next.summaryTokens &&
    previous.summarized === next.summarized
  );
}

/** Compare the data that can change a transcript row's rendered output. */
function transcriptEntryEqual(
  previous: TranscriptEntry,
  next: TranscriptEntry,
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "message" && next.kind === "message") {
    return previous.message === next.message;
  }
  if (previous.kind === "compaction" && next.kind === "compaction") {
    return compactionMarksEqual(previous.mark, next.mark);
  }
  if (previous.kind === "assistant-turn" && next.kind === "assistant-turn") {
    return assistantTurnPropsEqual(
      { entry: previous, isActive: false },
      { entry: next, isActive: false },
    );
  }
  return false;
}

function TranscriptEntryView({
  entry,
  isRunning,
  isActive,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
}) {
  if (entry.kind === "assistant-turn") {
    return <AssistantTurn entry={entry} isActive={isActive} />;
  }
  if (entry.kind === "compaction") {
    return <CompactionRow mark={entry.mark} />;
  }
  return <MessageRow message={entry.message} isRunning={isRunning} />;
}

function transcriptEntryKey(entry: TranscriptEntry): string {
  if (entry.kind === "compaction") return entry.mark.id;
  if (entry.kind === "assistant-turn") return entry.id;
  return entry.message.id;
}

type TranscriptHistoryProps = {
  entries: TranscriptEntry[];
  isRunning: boolean;
};

/**
 * Keep the completed transcript out of the streaming reconciliation path.
 * The projection is still rebuilt for correctness, but React can now bail out
 * before walking every historical row when only the active tail changed.
 */
const TranscriptHistory = memo(function TranscriptHistory({
  entries,
  isRunning,
}: TranscriptHistoryProps) {
  return (
    <>
      {entries.map((entry) => (
        <TranscriptEntryView
          key={transcriptEntryKey(entry)}
          entry={entry}
          isRunning={isRunning}
          isActive={false}
        />
      ))}
    </>
  );
}, (previous, next) => {
  if (
    previous.isRunning !== next.isRunning ||
    previous.entries.length !== next.entries.length
  ) {
    return false;
  }
  return previous.entries.every((entry, index) =>
    transcriptEntryEqual(entry, next.entries[index]),
  );
});

const TranscriptTail = memo(function TranscriptTail({
  entry,
  isRunning,
  isActive,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
}) {
  return (
    <TranscriptEntryView
      entry={entry}
      isRunning={isRunning}
      isActive={isActive}
    />
  );
}, (previous, next) =>
  previous.isRunning === next.isRunning &&
  previous.isActive === next.isActive &&
  transcriptEntryEqual(previous.entry, next.entry)
);

const AssistantTurn = memo(function AssistantTurn({
  entry,
  isActive,
}: AssistantTurnProps) {
  const { t } = useTranslation();
  const retryAssistantMessage = useAppStore((s) => s.retryAssistantMessage);
  const forkAssistantMessage = useAppStore((s) => s.forkAssistantMessage);
  const providerModels = useAppStore((s) => s.providerModels);
  const providers = useAppStore((s) => s.providers);
  const messages = assistantTurnMessages(entry);
  const content = assistantTurnContent(entry);
  const actionMessage = [...messages]
    .reverse()
    .find((message) => (message.content || "").trim());
  const metaMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.modelId ||
        message.usage ||
        message.responseDurationMs ||
        message.responseOutputTokens,
    );
  const latestUsageMessage = [...messages]
    .reverse()
    .find((message) => message.usage);
  const latestUsage = latestMessageUsage(messages);
  const usage = assistantTurnUsage(entry);
  const tools = assistantTurnTools(entry);
  const responseDurationMs = assistantTurnResponseDuration(entry);
  const responseOutputTokens = assistantTurnResponseOutputTokens(entry);
  const responseOutputEstimated = assistantTurnResponseOutputIsEstimated(entry);
  const modelId = metaMessage?.modelId ?? latestUsageMessage?.modelId;
  const contextWindow = latestUsage
    ? resolveContextWindow(
        latestUsageMessage?.providerId ?? metaMessage?.providerId,
        latestUsageMessage?.modelId ?? modelId,
        providerModels,
        providers,
      )
    : DEFAULT_CONTEXT_WINDOW;
  const hasError = messages.some((message) => Boolean(message.error));
  const complete =
    !isActive && !hasError && Boolean(content) && Boolean(actionMessage);
  const streaming =
    isActive && messages.some((message) => message.status === "streaming");

  // Collect delegation statuses across ALL activity parts of this turn so that
  // a TaskWait in one part can inform the Task cards in a different part.
  const turnAllActivityItems = useMemo(
    () =>
      entry.parts.flatMap((part) =>
        part.kind === "activity" ? part.items : [],
      ),
    [entry.parts],
  );
  const turnDelegationStatuses = useMemo(
    () => collectDelegationStatuses(turnAllActivityItems),
    [turnAllActivityItems],
  );
  const turnDelegationTimings = useMemo(
    () => collectDelegationTimings(turnAllActivityItems),
    [turnAllActivityItems],
  );

  return (
    <div
      className={`message-row assistant assistant-turn${streaming ? " streaming" : ""}`}
      data-minimap-id={entry.anchorId}
      role="article"
      aria-label={t("chat.assistantMessage")}
    >
      <div className="message-col">
        {entry.parts.map((part, index) =>
          part.kind === "activity" ? (
            <ActivityGroup
              key={`activity-${part.items[0].message.id}`}
              items={part.items}
              endedAt={part.endedAt}
              isActive={isActive && index === entry.parts.length - 1}
              turnDelegationStatuses={turnDelegationStatuses}
              turnDelegationTimings={turnDelegationTimings}
            />
          ) : (
            <div
              className={`message-bubble assistant-turn-fragment${
                isActive && part.message.status === "streaming"
                  ? " streaming"
                  : ""
              }`}
              key={part.message.id}
            >
              {part.message.content ? (
                <div className="prose-chat">
                  <Markdown source={part.message.content} />
                </div>
              ) : null}
              {part.message.error ? (
                <AssistantErrorMessage message={part.message} />
              ) : null}
            </div>
          ),
        )}
        {!isActive && metaMessage ? (
          <MessageMeta
            modelId={modelId}
            usage={usage}
            contextUsage={latestUsage}
            contextWindow={contextWindow}
            tools={tools}
            responseDurationMs={responseDurationMs}
            responseOutputTokens={responseOutputTokens}
            responseOutputEstimated={responseOutputEstimated}
          />
        ) : null}
        {(content || hasError) && actionMessage ? (
          <div className="message-actions">
            {content ? <CopyButton text={content} label={t("chat.copy")} /> : null}
            {complete ? (
              <button
                className="copy-btn icon"
                data-tip={t("chat.forkResponse")}
                aria-label={t("chat.forkResponse")}
                onClick={() => void forkAssistantMessage(actionMessage.id)}
              >
                <IconBranch size={13} />
              </button>
            ) : null}
            {complete ? (
              <button
                className="copy-btn icon"
                data-tip={t("chat.retry")}
                aria-label={t("chat.retry")}
                onClick={() => void retryAssistantMessage(actionMessage.id)}
              >
                <IconReview size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}, assistantTurnPropsEqual);

/**
 * The transcript trace of one compaction, matching Codex's `ContextCompaction`
 * turn item: a divider that says the earlier turns above it are now a summary.
 * It carries no actions — nothing about a persisted checkpoint is undoable.
 */
function CompactionRow({ mark }: { mark: ContextCompactionMark }) {
  const { t } = useTranslation();
  return (
    <div className="transcript-compaction-row" role="separator">
      <span className="transcript-compaction-label">
        {t("chat.compactionRow", { times: mark.generation })}
      </span>
      <span className="transcript-compaction-detail">
        {mark.summarized
          ? t("chat.compactionRowSummary", {
              tokens: formatTokenCount(mark.summaryTokens),
            })
          : t("chat.compactionRowNoSummary")}
      </span>
    </div>
  );
}


const HISTORY_REVEAL_THRESHOLD_PX = 120;

export const ChatTranscript = memo(function ChatTranscript({
  sessionId,
  messages,
  hasMoreBefore = false,
  onLoadOlder,
  isRunning,
  pendingPermission,
  queuedPermissions = 0,
  askPending = false,
  planningState,
  paneVisible = true,
}: {
  sessionId: string | undefined;
  messages: UiMessage[];
  hasMoreBefore?: boolean;
  onLoadOlder?: () => Promise<void>;
  isRunning: boolean;
  pendingPermission?: PendingPermission;
  /** Requests waiting behind this one, from other delegates (ADR 0062). */
  queuedPermissions?: number;
  askPending?: boolean;
  planningState?: PlanningState;
  /**
   * Whether this instance's retained pane is the one on screen (ADR 0136). A
   * hidden pane keeps its DOM and scroll offset but must not chase the stream
   * or re-anchor, because its scroller has no visible viewport to correct.
   */
  paneVisible?: boolean;
}) {
  const { t } = useTranslation();
  const latestTurnResult = useAppStore((state) =>
    sessionId ? state.latestTurnResults[sessionId] : undefined,
  );
  const approvalPending = useAppStore((state) =>
    Boolean(
      sessionId && state.pendingPlans[sessionId]?.status === "pending",
    ),
  );
  // Plan and Goal both project `planning`; the durable mode names which
  // contract is being written, so the indicator can use that kind's copy.
  const planningKind = useAppStore(
    (state) =>
      proposalKindForMode(
        state.sessions.find((session) => session.id === sessionId)?.mode ??
          "agent",
      ) ?? "plan",
  );
  const compactions = useAppStore((state) =>
    sessionId ? state.sessionCompactions[sessionId] : undefined,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyBoundaryRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const wasRunningRef = useRef(isRunning);
  const followFrameRef = useRef(0);
  const prependHeightRef = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // Steady-state cap on mounted history rows (D261). Grows when the user
  // reaches the top of the window; reset per session below.
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW_MIN);
  // Read by `reachTop`, which must stay referentially stable for the scroll
  // listener; the projection it describes is only known later in this render.
  const historyLengthRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // `scrollTo({ behavior: "auto" })` is synchronous. Recording the exact
    // target avoids the following native scroll event being mistaken for a
    // user gesture when the composer or the new turn changes the content
    // height in the same frame.
    if (behavior === "auto") lastScrollTopRef.current = targetTop;
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);

  // A user scroll-up gesture always emits input before its scroll events;
  // programmatic follow scrolling and layout clamps (composer collapse on
  // send, indicator mount/unmount) never do. Track the last real input so
  // `handleScroll` can tell the two apart and never let a clamp between a
  // follow `scrollTo` and its native event release follow mode.
  const markScrollGesture = useCallback((event: Event) => {
    if (
      event.type === "wheel" ||
      event.type === "touchstart" ||
      event.type === "touchmove"
    ) {
      lastScrollGestureAtRef.current = performance.now();
      return;
    }
    if (event.type === "pointerdown") {
      lastScrollGestureAtRef.current = performance.now();
      return;
    }
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "PageUp" ||
        key === "PageDown" ||
        key === "Home" ||
        key === "End" ||
        key === " "
      ) {
        lastScrollGestureAtRef.current = performance.now();
      }
    }
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", markScrollGesture, { passive: true });
    el.addEventListener("touchstart", markScrollGesture, { passive: true });
    el.addEventListener("touchmove", markScrollGesture, { passive: true });
    el.addEventListener("pointerdown", markScrollGesture, { passive: true });
    el.addEventListener("keydown", markScrollGesture, { passive: true });
    return () => {
      el.removeEventListener("wheel", markScrollGesture);
      el.removeEventListener("touchstart", markScrollGesture);
      el.removeEventListener("touchmove", markScrollGesture);
      el.removeEventListener("pointerdown", markScrollGesture);
      el.removeEventListener("keydown", markScrollGesture);
    };
  }, [markScrollGesture]);

  // This instance belongs to one session for its whole lifetime (ADR 0136), so
  // "activation" is its own first layout: settle at the newest turn before the
  // first paint, with no cross-session state to unwind.
  useLayoutEffect(() => {
    cancelFollowScroll();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [cancelFollowScroll, scrollToBottom]);

  // Revisits restore this pane's own position. A hidden scroller can be clamped
  // while its content grows off screen, so the offset is captured on the way out
  // and reapplied during the layout phase that reveals the pane: a pane the user
  // had scrolled up in returns to that offset, a pinned one returns to the
  // bottom, and neither shows an intermediate frame.
  const retainedScrollTopRef = useRef<number | null>(null);
  const wasPaneVisibleRef = useRef(paneVisible);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const becameHidden = wasPaneVisibleRef.current && !paneVisible;
    const becameVisible = !wasPaneVisibleRef.current && paneVisible;
    // The transition is only consumed once there is a scroller to read or
    // position. Committing it before this guard would swallow the edge and lose
    // the offset a pane hidden before its scroller existed should return to.
    if (!el) return;
    wasPaneVisibleRef.current = paneVisible;
    if (becameHidden) {
      cancelFollowScroll();
      retainedScrollTopRef.current = el.scrollTop;
      return;
    }
    if (!becameVisible) return;
    if (pinnedRef.current) {
      scrollToBottom();
      return;
    }
    const retained = retainedScrollTopRef.current;
    if (retained === null) return;
    el.scrollTop = retained;
    lastScrollTopRef.current = retained;
  }, [cancelFollowScroll, paneVisible, scrollToBottom]);

  // A hidden pane must not chase its stream: its scroller has no visible
  // viewport, and the measurements a follow scroll depends on are unreliable
  // while it is out of view. It re-anchors when it is revealed instead.
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  const scheduleFollowScroll = useCallback(() => {
    if (!paneVisibleRef.current) return;
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (paneVisibleRef.current && pinnedRef.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    // Paging is a reading gesture, so a hidden pane never initiates one.
    if (!paneVisibleRef.current) return;
    if (!el || !hasMoreBefore || loadingOlder || !onLoadOlder) {
      return;
    }
    // Prepending rows changes scrollHeight. Capture the old height so the
    // user's viewport stays anchored to the same message after the page lands.
    prependHeightRef.current = el.scrollHeight;
    setLoadingOlder(true);
    void onLoadOlder().finally(() => setLoadingOlder(false));
  }, [hasMoreBefore, loadingOlder, onLoadOlder]);

  /**
   * Reaching the top escalates in two stages (D261): mount more of what is
   * already loaded, and only fetch an older page once the window covers all of
   * it. Both stages anchor the viewport the same way, because both change
   * scrollHeight above the rows the user is reading.
   */
  const reachTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grown = growTranscriptWindow(windowSize, historyLengthRef.current);
    if (grown !== windowSize) {
      // Mounting rows above the viewport changes scrollHeight exactly the way a
      // fetched page does, so it takes the same anchor.
      prependHeightRef.current = el.scrollHeight;
      setWindowSize(grown);
      return;
    }
    loadOlder();
  }, [loadOlder, windowSize]);

  // Anchors the viewport whenever rows appear above it — a fetched older page
  // (`messages.length`) or a grown mounted window (`windowSize`, D261). Both add
  // height above the reading position, so both are corrected here before paint.
  useLayoutEffect(() => {
    const previousHeight = prependHeightRef.current;
    if (previousHeight === null) return;
    const el = scrollRef.current;
    prependHeightRef.current = null;
    if (!el) return;
    const delta = el.scrollHeight - previousHeight;
    if (delta <= 0) return;
    el.scrollTop += delta;
    lastScrollTopRef.current = el.scrollTop;
  }, [messages.length, windowSize]);



  // Follow the stream only while the user is pinned to the bottom; a manual
  // scroll up pauses following and surfaces the jump-to-latest pill.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX) reachTop();
    const wasPinned = pinnedRef.current;
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned: pinnedRef.current,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    // Only a real gesture (wheel / trackpad / touch / scrollbar / keyboard)
    // releases follow. When the composer collapses or an indicator row
    // unmounts right after send, the browser clamps scrollTop and emits a
    // scroll event that looks like an upward gesture; without this guard it
    // would cancel follow and leave the transcript stuck above the new turn.
    const released =
      transition.releasedFollow &&
      isRecentScrollGesture(
        performance.now(),
        lastScrollGestureAtRef.current,
      );
    if (released) {
      pinnedRef.current = false;
      setShowJump(true);
    } else if (transition.releasedFollow) {
      // Programmatic / layout noise: re-baseline the observed position and
      // keep the follow state unchanged instead of treating it as a user
      // gesture. A pinned transcript re-asserts the bottom; an unpinned one
      // stays unpinned.
      pinnedRef.current = wasPinned;
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setShowJump(transition.showJump);
    }
  }, [cancelFollowScroll, reachTop, scheduleFollowScroll]);

  // Send / retry / regenerate always re-pins follow mode so the new prompt and
  // its stream stay in view, even if the user had scrolled up through history.
  // This must run in the layout phase: the send state is committed before the
  // persisted user-message event arrives, and a passive effect allows one
  // frame where a long transcript can remain at its old/top position.
  useLayoutEffect(() => {
    const turnStarted = isRunning && !wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (!turnStarted || !paneVisible) return;
    cancelFollowScroll();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
    scheduleFollowScroll();
  }, [
    cancelFollowScroll,
    isRunning,
    paneVisible,
    scheduleFollowScroll,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [
    messages,
    isRunning,
    pendingPermission?.requestId,
    askPending,
    approvalPending,
    planningState,
    scheduleFollowScroll,
  ]);

  // Streamed Markdown and expanded activity rows can change content height, so
  // keep pinned follow synchronized with the observed layout.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(scheduleFollowScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleFollowScroll]);

  // Streaming tokens are deferred so the full historical transcript tree does
  // not rebuild at the same priority as the tail. The pane's own first commit is
  // never deferred: its content must be on screen in the commit that reveals it,
  // otherwise the reveal shows one empty frame.
  const firstCommitRef = useRef(true);
  const firstCommit = firstCommitRef.current;
  const deferredMessages = useDeferredValue(messages);
  const deferredCompactions = useDeferredValue(compactions);
  const renderedMessages = firstCommit ? messages : deferredMessages;
  const renderedCompactions = firstCommit ? compactions : deferredCompactions;
  const { entries, visible } = useMemo(
    () => buildTranscriptEntries(renderedMessages, renderedCompactions),
    [renderedMessages, renderedCompactions],
  );
  // Memoized so a re-render that changed no message (jump pill, loading row,
  // window growth) hands `TranscriptHistory` the same array, letting its
  // comparator bail on identity instead of walking every mounted row.
  const allHistoryEntries = useMemo(() => entries.slice(0, -1), [entries]);
  const tailEntry = entries.at(-1);
  // Published for `reachTop`, which is declared above this projection but only
  // runs from a scroll event, long after this render committed.
  historyLengthRef.current = allHistoryEntries.length;

  // Progressive hydration, now scoped to this pane's own first commit
  // (ADR 0136): mount only the bottom portion of the transcript when the pane
  // mounts, then expand to the steady-state window after paint, with a spacer
  // holding the scroll height. Because the instance belongs to one session, the
  // gate is plain local mount state rather than a comparison against whichever
  // session was rendered last.
  //
  // The gate has to be derived during render, not set from an effect. Deciding
  // it from a layout effect mounted the *whole* history first and only then cut
  // it back to the budget, so a long session built its entire DOM, discarded it,
  // and rebuilt it, which is the opposite of what bounding the first commit is
  // for.
  //
  // The expansion target is the mounted window (D261), not the whole history: a
  // paged-in session used to end up with every row mounted for good, retaining
  // its Markdown and highlighting for rows nobody was looking at.
  const [hydrationTick, setHydrationTick] = useState(0);
  const hydrationBounded =
    firstCommit && allHistoryEntries.length > TRANSCRIPT_INITIAL_MOUNT;
  // The bounded commit and the expansion must show the transcript at the same
  // place. A spacer sized from a per-entry guess cannot match the rows it stands
  // in for, so the expansion moved the visible text by the estimate error - the
  // reported page-flip jitter on a session switch. The spacer now only reserves
  // enough height to make the bottom reachable, and the expansion re-pins the
  // exact bottom in the same layout phase it commits in.
  //
  // The "needs re-anchoring" flag is derived from which session was bounded, not
  // written during render: StrictMode double-renders and abandoned concurrent
  // renders would otherwise leave a plain boolean ref set and re-bottom a
  // transcript the user had scrolled up in.
  const boundedFirstCommitRef = useRef(false);
  useEffect(() => {
    if (!hydrationBounded) {
      firstCommitRef.current = false;
      return;
    }
    boundedFirstCommitRef.current = true;
    const frame = requestAnimationFrame(() => {
      firstCommitRef.current = false;
      setHydrationTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(frame);
    // `hydrationTick` is a dependency so a pane whose expansion is still queued
    // re-evaluates instead of holding a stale frame.
  }, [hydrationBounded, hydrationTick]);

  const transcriptWindow = reduceTranscriptWindow({
    historyLength: allHistoryEntries.length,
    windowSize,
    initialCommit: hydrationBounded,
  });
  // Memoized so unrelated re-renders (jump pill, loading row) hand
  // `TranscriptHistory` the same array and it can bail on identity instead of
  // walking every mounted row.
  const historyEntries = useMemo(
    () =>
      transcriptWindow.bounded
        ? allHistoryEntries.slice(-transcriptWindow.mounted)
        : allHistoryEntries,
    [allHistoryEntries, transcriptWindow.bounded, transcriptWindow.mounted],
  );

  // Runs in the same layout phase the expansion commits in, before the browser
  // paints it, so mounting the remaining history cannot move the rows the user
  // is already looking at. A user who scrolled up during the bounded frame keeps
  // their position: only a still-pinned transcript is re-bottomed.
  useLayoutEffect(() => {
    if (hydrationBounded || !boundedFirstCommitRef.current) return;
    boundedFirstCommitRef.current = false;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, hydrationBounded, hydrationTick, scrollToBottom]);

  // The minimap must describe the mounted rows, not every loaded message: it
  // resolves a click by looking up the marker's node in the scroller, so a dash
  // for a withheld row would jump nowhere (D261).
  const minimapMessages = useMemo(
    () =>
      transcriptWindow.bounded
        ? transcriptEntryMessages(
            tailEntry ? [...historyEntries, tailEntry] : historyEntries,
          )
        : visible,
    [historyEntries, tailEntry, transcriptWindow.bounded, visible],
  );
  const hasEarlierHistory = transcriptWindow.hiddenAbove > 0 || hasMoreBefore;

  const revealEarlierHistory = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX) {
      reachTop();
      return;
    }
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [cancelFollowScroll, reachTop]);

  // D269: history progression follows the visible top boundary, not only a
  // native scroll event. A tail page can collapse to less than one viewport,
  // and a fetched page can initially sit outside the mounted window; neither
  // case changes scrollTop, so the old scroll-only trigger could strand both
  // the earlier transcript and the minimap. Re-observing after each window/page
  // transition keeps advancing until the boundary leaves the near-top band or
  // no earlier history remains.
  useEffect(() => {
    const root = scrollRef.current;
    const boundary = historyBoundaryRef.current;
    if (!root || !boundary || !hasEarlierHistory) return;
    // A hidden pane's scroller is unrendered and reports `scrollTop === 0`,
    // which reads as "at the top" and would page history for a session nobody is
    // looking at. The pane re-evaluates when it is revealed, because
    // `paneVisible` is a dependency of this effect.
    if (!paneVisible) return;
    let frame = 0;
    const advanceIfHistoryBoundaryVisible = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          scrollRef.current !== root ||
          root.scrollTop > HISTORY_REVEAL_THRESHOLD_PX
        ) {
          return;
        }
        reachTop();
      });
    };

    // Covers an underfilled tail immediately, including environments without
    // IntersectionObserver; the observer then owns subsequent visibility changes.
    advanceIfHistoryBoundaryVisible();
    if (typeof IntersectionObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          advanceIfHistoryBoundaryVisible();
        }
      },
      {
        root,
        rootMargin: `${HISTORY_REVEAL_THRESHOLD_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(boundary);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `hiddenAbove` is a dependency because an IntersectionObserver does not
    // re-notify while the boundary stays continuously visible: growing the
    // window changes neither `messages.length` nor the intersection state, so
    // without it a still-underfilled transcript would advance exactly once and
    // then stall with loaded rows unmounted. Each re-run performs one bounded
    // growth step, so the escalation stays monotonic and terminates when the
    // window covers the loaded history or the boundary leaves the band.
  }, [
    hasEarlierHistory,
    hydrationTick,
    loadingOlder,
    messages.length,
    paneVisible,
    reachTop,
    sessionId,
    transcriptWindow.hiddenAbove,
  ]);

  const lastEntry = entries[entries.length - 1];
  const lastTurnPart =
    lastEntry?.kind === "assistant-turn" ? lastEntry.parts.at(-1) : undefined;
  const activeToolGroup = isRunning && lastTurnPart?.kind === "activity";
  const assistantIsAnswering =
    lastTurnPart?.kind === "message" &&
    lastTurnPart.message.status === "streaming" &&
    Boolean((lastTurnPart.message.content || "").trim());
  // Show immediate feedback after send, then let the concrete activity row
  // (thinking/tool/answer) take over so the transcript never duplicates state.
  const showWorking =
    isRunning &&
    !pendingPermission &&
    !askPending &&
    !approvalPending &&
    planningState !== "planning" &&
    !activeToolGroup &&
    !assistantIsAnswering;
  const showPlanning =
    isRunning &&
    planningState === "planning" &&
    !approvalPending &&
    !pendingPermission &&
    !askPending;

  return (
    <div className="thread-wrap" ref={wrapRef}>
      {/* The minimap measures row positions against a rendered scroller. A
        * hidden pane has none, so measuring there would cache junk offsets and
        * reuse them on reveal. It is out of flow and re-measures on mount, so
        * leaving it out while hidden costs nothing. */}
      {paneVisible ? (
        <ConversationMinimap
          scrollRef={scrollRef}
          messages={minimapMessages}
          hasEarlier={hasEarlierHistory}
          loadingEarlier={loadingOlder}
          onRevealEarlier={revealEarlierHistory}
        />
      ) : null}
      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
      >
        <div className="thread-content" ref={contentRef}>
          <div
            ref={historyBoundaryRef}
            className="transcript-history-loading"
            role="status"
            aria-live="polite"
            aria-hidden={!loadingOlder}
          >
            {loadingOlder ? t("chat.loadingEarlierMessages") : null}
          </div>
          {hydrationBounded ? (
            // One viewport of slack, not a per-entry estimate. The spacer exists
            // so the bounded commit can still scroll to its bottom; sizing it
            // from a guessed row height made the expansion correct that guess in
            // view, which is exactly the jitter this avoids.
            <div className="transcript-hydration-spacer" aria-hidden />
          ) : null}
          <TranscriptHistory entries={historyEntries} isRunning={isRunning} />
          {tailEntry ? (
            <TranscriptTail
              entry={tailEntry}
              isRunning={isRunning}
              isActive={isRunning && tailEntry.kind === "assistant-turn"}
            />
          ) : null}
          <TurnOutcomeCard
            messages={messages}
            result={latestTurnResult}
          />
          {pendingPermission ? (
            <PermissionCard
              key={pendingPermission.requestId}
              permission={pendingPermission}
              queued={queuedPermissions}
            />
          ) : null}
          {showPlanning ? <PlanningIndicator kind={planningKind} /> : null}
          {showWorking ? <WorkingIndicator /> : null}
        </div>
      </div>
      {showJump ? (
        <button
          className="jump-latest-btn"
          aria-label={t("chat.scrollToBottom")}
          title={t("chat.scrollToBottom")}
          onClick={() => {
            pinnedRef.current = true;
            setShowJump(false);
            scrollToBottom(
              window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
            );
          }}
        >
          <IconArrowDown size={14} />
        </button>
      ) : null}
    </div>
  );
});
