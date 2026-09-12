import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { formatToolDuration } from "../../../lib/tool-display";
import { toolResultPayload } from "../../../lib/tool-presentation";
import {
  subagentOutcome,
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type DelegationFailure,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import type { SubagentRun } from "../../../lib/assistant-turns";
import { useAppStore } from "../../../stores/app-store";
import {
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleAlert,
  IconStop,
  IconTarget,
} from "../../../components/icons";
import { CopyButton } from "./shared";
import {
  delegateAgentName,
  delegateModelId,
  delegateThinkingLevel,
} from "./model";
import {
  SubagentRunRows,
  ToolRow,
} from "./ToolRow";

function delegateTaskDescription(message: UiMessage): string {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const task = (args as { task?: unknown }).task;
  return typeof task === "string" ? task.trim() : "";
}

/**
 * Why a settled delegate failed, at the foot of its detail panel (issue #161).
 *
 * The step stream ends on `Failed` / `Timed out` / `Aborted` without saying
 * why: a delegate that dies before emitting a message row has no other carrier
 * for its reason, and the badge plus a duration is all a reader gets. The
 * runtime already reports `error: { code, message }` on the delegation roster
 * entry, so it is rendered here with the same visual language as the parent
 * reply's error card instead of being reachable only by reading the raw tool
 * result.
 */
function SubagentFailureCard({
  outcome,
  failure,
}: {
  outcome: SubagentOutcome;
  failure: DelegationFailure;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const detailsId = useId();
  const headingId = useId();
  // A known runtime code already has a localized sentence; otherwise the
  // outcome's own label is the summary, which stays truthful and localized.
  const localizedKey = `errors.${failure.code}`;
  const localized = failure.code ? t(localizedKey) : localizedKey;
  const summary =
    failure.code && localized !== localizedKey
      ? localized
      : t(`chat.subagentStatus.${outcome}`);
  // A code-only error carries no detail to disclose, so it stays a one-line
  // card rather than opening onto an empty box.
  const hasMessage = failure.message.length > 0;

  return (
    <section
      className="message-error subagent-failure"
      aria-labelledby={headingId}
      data-testid="subagent-failure"
    >
      <div className="message-error-heading">
        <span className="message-error-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="message-error-copy">
          <strong id={headingId}>{summary}</strong>
          {failure.code ? <code>{failure.code}</code> : null}
        </div>
        <div className="message-error-actions">
          {/* The toggle stays outside the collapsed region, otherwise hiding
            * the details would take away the control that brings them back. */}
          {hasMessage ? (
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
          ) : null}
        </div>
      </div>
      {hasMessage ? (
        <div
          id={detailsId}
          className={`message-error-details ${open ? "open" : ""}`}
          hidden={!open}
        >
          <div className="message-error-raw">
            <pre className="selectable">{failure.message}</pre>
            <CopyButton text={failure.message} label={t("chat.copyErrorDetails")} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The side-sheet view for a selected delegate. It shows a sticky identity
 * header, the task as an inset grouped card, and the live process timeline.
 * Reports and counters remain omitted from this compact surface.
 */
export function SubagentDetail({
  message,
  delegate,
  delegationStatuses,
  delegationFailures,
  delegationTimings,
}: {
  message: UiMessage;
  delegate?: SubagentRun;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationFailures?: ReadonlyMap<string, DelegationFailure>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
}) {
  const { t } = useTranslation();
  const agentName = delegateAgentName(message, delegate);
  const modelId = delegateModelId(message);
  const thinkingLevel = delegateThinkingLevel(message);
  const thinkingLabel = thinkingLevel ?? "";
  const modelLabel = [modelId, thinkingLabel].filter(Boolean).join(" ");
  const outcome = subagentOutcome(message, delegationStatuses);
  const payload = toolResultPayload(message);
  const payloadRecord =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { delegationId?: unknown; startedAt?: unknown; completedAt?: unknown })
      : undefined;
  const delegationId =
    typeof payloadRecord?.delegationId === "string"
      ? payloadRecord.delegationId
      : message.toolCallId || message.id;
  const timing = delegationTimings?.get(delegationId);
  const failure = delegationFailures?.get(delegationId);
  const startedAt =
    timing?.startedAt ??
    (typeof payloadRecord?.startedAt === "number" ? payloadRecord.startedAt : undefined);
  const completedAt =
    timing?.completedAt ??
    (typeof payloadRecord?.completedAt === "number" ? payloadRecord.completedAt : undefined);
  const [now, setNow] = useState(Date.now);
  const durationMs =
    startedAt !== undefined
      ? Math.max(0, (completedAt ?? (outcome === "running" ? now : startedAt)) - startedAt)
      : message.toolDurationMs;
  const duration =
    typeof durationMs === "number" && durationMs > 0
      ? formatToolDuration(durationMs / 1000)
      : "";
  const taskDescription = delegateTaskDescription(message);
  const taskBodyId = useId();
  const taskLabelId = useId();
  const taskBodyRef = useRef<HTMLDivElement>(null);
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [taskOverflow, setTaskOverflow] = useState(false);
  const outcomeClass = outcome.replaceAll("_", "-");

  useLayoutEffect(() => {
    setTaskExpanded(false);
  }, [taskDescription]);

  useLayoutEffect(() => {
    const element = taskBodyRef.current;
    if (!element) return;
    const measure = () => {
      const overflowing = element.scrollHeight > element.clientHeight + 1;
      setTaskOverflow((current) => (taskExpanded ? current : overflowing));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [taskDescription, taskExpanded]);

  useEffect(() => {
    if (outcome !== "running") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [outcome]);

  return (
    <div className="subagent-detail" data-testid="subagent-detail">
      <header className="subagent-detail-hero">
        <div className="subagent-detail-heading">
          <span className="subagent-detail-avatar" aria-hidden>
            <IconBot size={18} />
            <span className={`subagent-detail-status outcome-${outcomeClass}`} />
          </span>
          <div className="subagent-detail-heading-copy">
            <strong className="subagent-detail-name">
              {agentName || t("chat.subagentUnnamed")}
            </strong>
            {modelLabel ? (
              <span
                className="subagent-detail-model"
                title={modelLabel}
                aria-label={modelLabel}
              >
                {modelLabel}
              </span>
            ) : null}
          </div>
        </div>
        <div
          className="subagent-detail-summary"
          role="list"
          aria-label={t("panel.subagent")}
        >
          <span
            className={`subagent-detail-badge outcome-${outcomeClass}`}
            role="listitem"
          >
            {t(`chat.subagentStatus.${outcome}`)}
          </span>
          {duration ? (
            <span className="subagent-detail-meta" role="listitem">
              {duration}
            </span>
          ) : null}
        </div>
      </header>
      <section className="subagent-detail-task" aria-labelledby={taskLabelId}>
        <div className="subagent-detail-section-label" id={taskLabelId}>
          {t("panel.subagentTask")}
        </div>
        <div className="subagent-detail-task-card">
          <div
            id={taskBodyId}
            ref={taskBodyRef}
            className={`subagent-task-message-body selectable${
              taskExpanded ? " is-expanded" : " is-collapsed"
            }`}
          >
            {taskDescription || t("panel.subagentTaskEmpty")}
          </div>
          {taskOverflow ? (
            <button
              type="button"
              className="subagent-task-toggle"
              aria-expanded={taskExpanded}
              aria-controls={taskBodyId}
              onClick={() => setTaskExpanded((expanded) => !expanded)}
            >
              <span>
                {taskExpanded
                  ? t("chat.subagentTaskCollapse")
                  : t("chat.subagentTaskExpand")}
              </span>
              <IconChevronDown size={12} aria-hidden />
            </button>
          ) : null}
        </div>
      </section>
      {delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          scrollable={false}
          variant="dock"
        />
      ) : null}
      {/* A completed delegate has nothing to explain, so the card is tied to a
        * non-success terminal outcome rather than to the error field alone. */}
      {failure && outcome !== "completed" && outcome !== "running" ? (
        <SubagentFailureCard outcome={outcome} failure={failure} />
      ) : null}
    </div>
  );
}

/**
 * A truthful one-level graph of one parent fan-out (ADR 0062).
 *
 * The runtime has no delegate-to-delegate edges, so this deliberately stops at
 * main agent -> Task nodes instead of implying dependencies that do not exist.
 */
export function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
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
            onUserInteraction={onUserInteraction}
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
