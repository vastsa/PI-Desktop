import {
  Fragment,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentActivity,
  AgentActivityAgent,
  ProposalKind,
} from "@pi-desktop/shared";
import {
  PROVIDER_RETRY_MAX_RETRIES,
} from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
} from "../../../lib/assistant-turns";
import {
  messageThinking as thinkingText,
  subagentRunsEqual,
} from "../../../lib/assistant-turns";
import {
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  collectDelegationStatuses,
  collectDelegationTimings,
  delegationTimingBounds,
  isDelegationActivityItem,
  lifecycleKindOf,
  summarizeSubagentActivity,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import {
  formatToolDuration,
  getToolAction,
  getToolSummary,
} from "../../../lib/tool-display";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { IconChevronRight, IconCircleAlert, IconSparkles, IconWorkflow } from "../../../components/icons";
import {
  DisclosureCollapseRail,
  TOOL_RUNNING_KEYS,
  ThinkingRow,
  useAutomaticDisclosure,
} from "./shared";
import { SubagentTopology } from "./SubagentDetail";
import { ToolRow } from "./ToolRow";

type Translate = (key: string, options?: Record<string, unknown>) => string;

type ActivityItem = AssistantActivityItem;

export function activityItemDetail(item: ActivityItem): string {
  if (item.kind === "thinking") {
    // Latest thought line, so a collapsed header reads like a live ticker.
    const lines = thinkingText(item.message)
      .split("\n")
      .map((line) => line.replace(/^#+\s*|\*\*/g, "").trim())
      .filter(Boolean);
    return lines[lines.length - 1] || "";
  }
  if (lifecycleKindOf(item.message)) {
    return delegationRosterSummary(delegationRoster(item.message));
  }
  return getToolSummary(item.message.toolName, item.message.toolArgs);
}


function waitingSubagentActionLabel(
  agent: AgentActivityAgent,
  t: Translate,
): string {
  if (agent.lastPhase === "thinking") return t("chat.thinking");
  if (agent.lastPhase === "waiting-model") return t("chat.waitingForModel");
  if (agent.lastToolName) {
    return t(TOOL_RUNNING_KEYS[getToolAction(agent.lastToolName)]);
  }
  return "";
}

function waitingSubagentsLabel(
  activity: Extract<AgentActivity, { phase: "waiting-subagents" }>,
  t: Translate,
): string {
  const agents = activity.agents ?? [];
  if (agents.length === 1) {
    const action = waitingSubagentActionLabel(agents[0], t);
    const named = t("chat.waitingForSubagentNamed", { name: agents[0].name });
    return action ? `${named} · ${action}` : named;
  }
  const base = t("chat.waitingForSubagents", { count: activity.subagentCount });
  if (agents.length === 0) return base;
  const details = agents
    .map((agent) => {
      const action = waitingSubagentActionLabel(agent, t);
      return action ? `${agent.name} ${action}` : agent.name;
    })
    .join(", ");
  return `${base} · ${details}`;
}

function retryDelaySeconds(
  activity: Extract<AgentActivity, { phase: "retrying" }>,
  now: number,
): number {
  const delayMs = activity.retryDelayMs ?? 0;
  const elapsedMs = Math.max(0, now - activity.since);
  return Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));
}

export function runActivityLabel(
  activity: AgentActivity,
  t: Translate,
  now = Date.now(),
): string {
  switch (activity.phase) {
    case "starting":
      return t("chat.startingTurn");
    case "waiting-model":
      return t("chat.waitingForModel");
    case "preparing":
      return t("chat.preparingNextRequest");
    case "compacting":
      return t("chat.compactingContext");
    case "recovering":
      return t("chat.recoveringTurn");
    case "retrying":
      return t("chat.retryingModel", {
        delaySeconds: retryDelaySeconds(activity, now),
        attempt: activity.attempt,
        maxAttempts: PROVIDER_RETRY_MAX_RETRIES,
      });
    case "waiting-subagents":
      return waitingSubagentsLabel(activity, t);
  }
}

type ActivityGroupProps = {
  items: ActivityItem[];
  isActive: boolean;
  endedAt?: string;
  /** Current runtime wait phase, when the group owns the live turn tail. */
  runtimeActivity?: AgentActivity;
  /** Delegation statuses from the entire assistant turn (cross-activity-part). */
  turnDelegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Delegation timings from the entire assistant turn (cross-activity-part). */
  turnDelegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

/** Whether two activity items render identically, delegate rows included. */
export function activityItemsEqual(
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
    previous.runtimeActivity !== next.runtimeActivity ||
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

export const ActivityGroup = memo(function ActivityGroup({
  items,
  isActive,
  endedAt,
  runtimeActivity,
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
  // Parent tools after a Task fan-out live in a later activity part (D319), so
  // this card is not the turn's live tail while its delegates are still running.
  const topologyLive = hasSubagentTopology && subagentSummary.running > 0;
  const live = isActive || topologyLive;
  const {
    open,
    toggle: toggleDisclosure,
    collapse: collapseDisclosure,
    claim: claimDisclosure,
  } = useAutomaticDisclosure(live);
  const [now, setNow] = useState(Date.now);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const wasActiveRef = useRef(live);
  const messages = items.map((item) => item.message);
  const topologyTiming = hasSubagentTopology
    ? delegationTimingBounds(delegateItems, delegationTimings)
    : null;
  const startedAt =
    topologyTiming?.startedAt ??
    (Date.parse(messages[0]?.createdAt || "") || now);
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
    topologyTiming?.completedAt ??
    (Date.parse(endedAt || "") ||
      finishedAt ||
      (wasActiveRef.current ? now : fallbackEnd));
  const elapsedSeconds = Math.max(
    0,
    Math.floor(((live ? now : completedAt) - startedAt) / 1000),
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
        live
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
  const runtimeStatus = runtimeActivity
    ? runActivityLabel(runtimeActivity, t as Translate)
    : "";
  const currentDetail =
    live && !runtimeStatus && lastItem ? activityItemDetail(lastItem) : "";
  const tail = live && !open ? currentDetail : "";

  useEffect(() => {
    if (wasActiveRef.current && !live) setFinishedAt(Date.now());
    wasActiveRef.current = live;
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const renderActivityItems = () => {
    let renderedTopology = false;
    return items.map((item, itemIndex) => {
      if (hasSubagentTopology && isDelegationActivityItem(item)) {
        if (renderedTopology) return null;
        renderedTopology = true;
        return (
          <SubagentTopology
            key="subagent-topology"
            items={delegateItems}
            delegationStatuses={delegationStatuses}
            delegationTimings={delegationTimings}
            onUserInteraction={claimDisclosure}
          />
        );
      }
      return item.kind === "tool" ? (
        <Fragment key={item.message.id}>
          <ToolRow
            message={item.message}
            onUserInteraction={claimDisclosure}
            {...(item.delegate ? { delegate: item.delegate } : {})}
          />
          <ReviewChangeCard message={item.message} />
        </Fragment>
      ) : (
        <ThinkingRow
          key={`thinking-${item.message.id}`}
          message={item.message}
          streaming={isActive && item.message.status === "streaming"}
          autoOpen={live && itemIndex === items.length - 1}
          onUserInteraction={claimDisclosure}
        />
      );
    });
  };

  return (
    <div
      className={`tool-activity-group ${hasSubagentTopology ? "has-subagents" : ""} ${
        open ? "open" : ""
      } ${live ? "active" : ""}${
        runtimeActivity ? ` phase-${runtimeActivity.phase}` : ""
      }`}
    >
      <button
        className="tool-activity-header"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={toggleDisclosure}
      >
        <span className="tool-activity-icon" aria-hidden>
          {hasSubagentTopology ? (
            <IconWorkflow size={15} />
          ) : (
            <IconSparkles size={14} />
          )}
        </span>
        <span className={`tool-activity-label ${live ? "running" : ""}`}>
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
              onCollapse={collapseDisclosure}
            />
            {renderActivityItems()}
          </div>
        </div>
      </div>
    </div>
  );
}, activityGroupPropsEqual);

/** Keep the transcript responsive while the model waits for its first event. */
export function WorkingIndicator({ startedAt }: { startedAt?: number } = {}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(startedAt ?? Date.now());

  useEffect(() => {
    startedAtRef.current = startedAt ?? Date.now();
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      className="working-indicator"
      data-testid="working-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="working-indicator-label">{t("chat.running")}</span>
      {elapsed > 0 ? (
        <span className="working-elapsed" aria-hidden="true">
          {formatToolDuration(elapsed)}
        </span>
      ) : null}
    </div>
  );
}

export function RunActivityIndicator({ activity }: { activity: AgentActivity }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const retryErrorDetailsId = useId();

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.since]);

  const elapsed = formatToolDuration(
    Math.max(0, Math.floor((now - activity.since) / 1000)),
  );
  const label = runActivityLabel(activity, t as Translate, now);
  const retryError = activity.phase === "retrying" ? activity.error : undefined;
  const retryErrorSummary = retryError
    ? (() => {
        const key = `errors.${retryError.code}`;
        const localized = t(key);
        return localized === key ? t("chat.responseFailed") : localized;
      })()
    : undefined;
  const retryLabel = retryError
    ? `${label}: ${retryErrorSummary}: ${retryError.message}`
    : label;
  const labelContent = retryError ? (
    <span
      className="run-activity-retry-reason"
      tabIndex={0}
      aria-describedby={retryErrorDetailsId}
      aria-label={retryLabel}
    >
      <span className="working-indicator-label">{label}</span>
      <span
        id={retryErrorDetailsId}
        className="run-activity-error-popover message-error"
        role="tooltip"
      >
        <span className="message-error-heading">
          <span className="message-error-icon" aria-hidden>
            <IconCircleAlert size={16} />
          </span>
          <span className="message-error-copy">
            <strong>{retryErrorSummary}</strong>
            <code>
              {retryError.code}
              {retryError.providerStatus !== undefined
                ? ` · HTTP ${retryError.providerStatus}`
                : ""}
            </code>
          </span>
        </span>
        <span className="run-activity-error-message selectable">
          {retryError.message}
        </span>
      </span>
    </span>
  ) : (
    <span className="working-indicator-label">{label}</span>
  );

  return (
    <div
      className="working-indicator run-activity-indicator"
      data-phase={activity.phase}
      data-testid="run-activity-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {labelContent}
      <span className="working-elapsed" aria-hidden="true">
        {elapsed}
      </span>
    </div>
  );
}

export function PlanningIndicator({ kind }: { kind: ProposalKind }) {
  const { t } = useTranslation();
  return (
    <div
      className="planning-state-indicator"
      role="status"
      aria-live="polite"
      data-kind={kind}
      data-testid="planning-indicator"
    >
      <span className="working-indicator-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{t(`${kind}.planning`)}</span>
    </div>
  );
}
