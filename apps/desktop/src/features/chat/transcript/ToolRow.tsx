import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useOpenChatFileRef, useOpenPreviewTarget } from "../../../hooks/use-preview-target";
import { useFollowScroll } from "../../../hooks/use-follow-scroll";
import { getToolPreviewTarget } from "../../../lib/chat-links";
import {
  formatToolDuration,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryValue,
} from "../../../lib/tool-display";
import {
  buildToolPresentation,
  hasToolDetails,
  runOutcome,
  toolResultChips,
  toolResultPayload,
} from "../../../lib/tool-presentation";
import {
  subagentRunsEqual,
  type SubagentRun,
  type SubagentRunItem,
} from "../../../lib/assistant-turns";
import {
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  lifecycleKindOf,
  subagentOutcome,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ToolChips, ToolDetailBlocks } from "../../../components/ToolDetails";
import {
  IconArrowDown,
  IconBot,
  IconCheck,
  IconChevronRight,
  IconCircleAlert,
  IconStop,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  AssistantErrorMessage,
  DisclosureCollapseRail,
  LIFECYCLE_LABEL_KEYS,
  LIFECYCLE_RUNNING_KEYS,
  PREVIEWABLE_ACTIONS,
  ThinkingRow,
  ToolActionIcon,
  ToolCommandCopy,
  TOOL_ACTION_KEYS,
  TOOL_RUNNING_KEYS,
  useAutomaticDisclosure,
} from "./shared";
import {
  delegateAgentName,
  delegateModelId,
  delegateThinkingLevel,
} from "./model";

type ToolRowProps = {
  message: UiMessage;
  /** Rows the delegate produced, when this row is a `Task` call (ADR 0062). */
  delegate?: SubagentRun;
  /** Card treatment used when several Task calls form a delegation topology. */
  variant?: "default" | "topology";
  /** Claims the containing activity group when this row is manually used. */
  onUserInteraction?: () => void;
  /** Live delegation statuses read from the turn's lifecycle-tool rows. */
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Runtime timings read from the turn's delegation lifecycle rows. */
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

function toolRowDelegationId(message: UiMessage): string | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const delegationId = (payload as { delegationId?: unknown }).delegationId;
  return typeof delegationId === "string" ? delegationId : undefined;
}

/**
 * Streaming updates replace one message object at a time. Regular rows only
 * depend on that message and their nested run; topology rows additionally
 * depend on the status/timing for their own delegation, not on Map identity.
 */
function toolRowPropsEqual(
  previous: ToolRowProps,
  next: ToolRowProps,
): boolean {
  if (
    previous.message !== next.message ||
    previous.variant !== next.variant ||
    previous.onUserInteraction !== next.onUserInteraction ||
    !subagentRunsEqual(previous.delegate, next.delegate)
  ) {
    return false;
  }
  if (previous.variant !== "topology") return true;
  const previousId = toolRowDelegationId(previous.message);
  const nextId = toolRowDelegationId(next.message);
  if (previousId !== nextId) return false;
  if (!previousId || !nextId) return true;
  const previousTiming = previous.delegationTimings?.get(previousId);
  const nextTiming = next.delegationTimings?.get(nextId);
  return (
    previous.delegationStatuses?.get(previousId) ===
      next.delegationStatuses?.get(nextId) &&
    previousTiming?.startedAt === nextTiming?.startedAt &&
    previousTiming?.completedAt === nextTiming?.completedAt
  );
}

export const ToolRow = memo(function ToolRow({
  message,
  delegate,
  variant = "default",
  onUserInteraction,
  delegationStatuses,
  delegationTimings,
}: ToolRowProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const toggleSubagentPanel = useAppStore((s) => s.toggleSubagentPanel);
  const subagentPanel = useAppStore((s) => s.subagentPanel);
  const status = message.toolStatus;
  const action = getToolAction(message.toolName);
  // A run row states what the command did, not what the call around it did: an
  // exit code the shell reported outranks a tool call that came back fine
  // (D227). Property reads only, so a streaming row can afford it every tick.
  const run = action === "run" ? runOutcome(message) : null;
  const failed = status === "error" || run === "failed";
  // Tool details are always user-opened. Failure stays visible in the row head
  // through its status icon/label without expanding the payload automatically.
  const disclosure = useAutomaticDisclosure(false);
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
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
  const modelId = variant === "topology" ? delegateModelId(message) : "";
  const thinkingLevel =
    variant === "topology" ? delegateThinkingLevel(message) : undefined;
  const thinkingLabel = thinkingLevel ?? "";
  const modelLabel = [modelId, thinkingLabel].filter(Boolean).join(" ");
  // The delegate's last answer row is its report, so the body must not print
  // the same text a second time.
  const nestedReport = delegate?.items.some((item) => item.kind === "answer");
  // Streaming updates replace the message object each tick; only pay the
  // full payload walk once the row is actually expanded.
  const blocks =
    variant !== "topology" && open && hasDetails
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
  const panelSelectionId =
    typeof delegationId === "string" && delegationId
      ? delegationId
      : message.toolCallId || message.id;
  const panelOpen =
    variant === "topology" &&
    subagentPanel?.delegationId === panelSelectionId;
  const renderedOpen = variant === "topology" ? panelOpen : open;
  const inlineOpen = variant !== "topology" && open;
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
        renderedOpen ? "open" : ""
      } status-${run === "failed" ? "error" : status || "success"}${outcome ? ` outcome-${outcome.replaceAll("_", "-")}` : ""}`}
      role={variant === "topology" ? "listitem" : "region"}
      aria-label={`${t("chat.toolCall")}: ${rawName}${agentName ? `, ${agentName}` : ""}${modelLabel ? `, ${modelLabel}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`}
    >
      {variant === "topology" ? (
        <button
          className="subagent-topology-node-header"
          aria-expanded={panelOpen}
          aria-controls={hasDetails ? "subagent-panel" : undefined}
          disabled={!hasDetails}
          title={[agentName || rawName, modelLabel, summary].filter(Boolean).join(" · ")}
          onClick={() => {
            if (!hasDetails) return;
            onUserInteraction?.();
            toggleSubagentPanel(panelSelectionId);
          }}
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
              {modelLabel ? (
                <span
                  className="subagent-topology-node-model"
                  title={modelLabel}
                  aria-label={modelLabel}
                >
                  {modelLabel}
                </span>
              ) : null}
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
        </button>
      ) : (
        <div className={`tool-row-head${runHead ? " is-run" : ""}`}>
          <button
            className="tool-row-header"
            aria-expanded={open}
            aria-controls={hasDetails ? detailsId : undefined}
            disabled={!hasDetails}
            title={summary || rawName}
            onClick={() => hasDetails && toggleRow()}
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
              onClick={toggleRow}
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
            onCollapse={collapseRow}
          />
          <ToolDetailBlocks blocks={blocks} plain={runHead} />
        </div>
      ) : null}
      {inlineOpen && delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          onCollapse={collapseRow}
        />
      ) : null}
    </div>
  );
}, toolRowPropsEqual);

/**
 * What a delegate did, nested under the `Task` call that spawned it.
 *
 * The rows are the delegate's context, not the parent's, so they are visibly
 * one level in and stay collapsed with the call. Only one level is possible: a
 * delegate has no `Task` tool of its own (ADR 0062).
 */
export function SubagentRunRows({
  run,
  agentName,
  onCollapse,
  scrollable = true,
  variant = "inline",
}: {
  run: SubagentRun;
  agentName: string;
  onCollapse?: () => void;
  /** Side-panel mode lets the parent panel own the only scrollbar. */
  scrollable?: boolean;
  /** Dock headings are section labels; inline headings name the delegate. */
  variant?: "inline" | "dock";
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (run.items.length === 0) return null;
  const dock = variant === "dock";
  return (
    <div className={dock ? "subagent-run is-dock" : "subagent-run"}>
      {onCollapse ? (
        <DisclosureCollapseRail
          label={t("chat.collapseDetails")}
          onCollapse={onCollapse}
        />
      ) : null}
      <div
        className={dock ? "subagent-run-heading is-dock" : "subagent-run-heading"}
        id={headingId}
      >
        {dock ? null : <IconBot size={13} aria-hidden />}
        <span>
          {dock
            ? t("chat.subagentProcess")
            : agentName
              ? t("chat.subagentWork", { agent: agentName })
              : t("chat.subagentWorkUnnamed")}
        </span>
        <span className="subagent-run-count">
          {t("chat.processingSteps", { count: run.items.length })}
        </span>
      </div>
      <SubagentRunFollow
        headingId={headingId}
        items={run.items}
        scrollable={scrollable}
      />
    </div>
  );
}

/**
 * Nested follow-scroll for one expanded delegate (D302). Mounted only once
 * the run has rows, so the first layout pins to the latest output instead of
 * to an empty scroller.
 */
function SubagentRunFollow({
  headingId,
  items,
  scrollable = true,
}: {
  headingId: string;
  items: SubagentRunItem[];
  scrollable?: boolean;
}) {
  const { t } = useTranslation();
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
  } = useFollowScroll();

  useLayoutEffect(() => {
    if (!scrollable) return;
    scheduleFollowScroll();
  }, [items, scheduleFollowScroll, scrollable]);

  return (
    <div className="subagent-run-follow">
      {/* The rows scroll inside the run rather than growing the transcript
        * (D271). Follow sticks to the latest output while pinned (D302).
        * Labelled and focusable so a keyboard reader can reach the scroll
        * area the pointer can already use. */}
      <div
        ref={scrollRef}
        className={`subagent-run-rows${scrollable ? "" : " is-panel-flow"}`}
        role="group"
        tabIndex={scrollable ? 0 : undefined}
        aria-labelledby={headingId}
        onScroll={scrollable ? handleScroll : undefined}
      >
        <div ref={contentRef}>
          {items.map((item) =>
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
      {scrollable && showJump ? (
        <TooltipButton
          type="button"
          className="jump-latest-btn"
          ariaLabel={t("chat.scrollToBottom")}
          tooltip={t("chat.scrollToBottom")}
          onClick={jumpToLatest}
        >
          <IconArrowDown size={14} />
        </TooltipButton>
      ) : null}
    </div>
  );
}

/** The task text sent to the delegate, shown as the conversation-like body. */
