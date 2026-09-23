import type { SubagentOutcome } from "../../../lib/subagent-topology";
import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { formatToolDuration } from "../../../lib/tool-display";
import { activitySummary } from "../../../lib/activity-summary";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import {
  isTurnThinking,
  processContainsMessage,
  resolveThinkingDisplayMode,
  shouldAutoOpenTurnProcess,
  visibleProcessSteps,
  type TurnProcessTiming,
} from "../../../lib/turn-process";
import { useAppStore } from "../../../stores/app-store";
import {
  IconChevronRight,
  IconCircleAlert,
  IconSparkles,
} from "../../../components/icons";
import { DisclosureCollapseRail } from "./shared";
import { DisclosureScope, disclosureKey, useAutomaticDisclosure } from "./disclosure";

export function TurnProcess({
  turnId,
  processParts,
  turnParts,
  timing,
  isActive,
  delegationStatuses,
  children,
}: {
  turnId: string;
  processParts: readonly AssistantTurnPart[];
  turnParts: readonly AssistantTurnPart[];
  timing: TurnProcessTiming;
  isActive: boolean;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  children: ReactNode;
}) {
  const mode = useAppStore((state) =>
    resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode),
  );
  const search = useContext(TranscriptSearchContext);
  const revealRequest = useMemo(
    () =>
      search && processContainsMessage(processParts, search.messageId)
        ? search.requestId
        : undefined,
    [processParts, search],
  );
  const processItems = useMemo(
    () => processParts.flatMap((part) => (part.kind === "activity" ? part.items : [])),
    [processParts],
  );
  const summary = useMemo(
    () => activitySummary(processItems, delegationStatuses),
    [processItems, delegationStatuses],
  );
  const thinkingNow = useMemo(
    () => isTurnThinking(turnParts, isActive),
    [turnParts, isActive],
  );
  const stepCount = useMemo(
    () => visibleProcessSteps(processParts, mode, isActive),
    [processParts, mode, isActive],
  );
  const [now, setNow] = useState(Date.now);
  const { startedAt: timingStart, endedAt } = timing;
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  if (stepCount === 0) return null;
  const seconds =
    timingStart === undefined
      ? 0
      : Math.max(
          0,
          Math.floor(((isActive ? now : (endedAt ?? timingStart)) - timingStart) / 1000),
        );
  const phase = isActive ? "active" : "settled";
  return (
    <TurnProcessDisclosure
      identity={disclosureKey("turn", turnId, phase)}
      automaticOpen={shouldAutoOpenTurnProcess(mode, isActive, summary.issues > 0)}
      revealRequest={revealRequest}
      issueCount={summary.issues}
      toolCount={summary.tools}
      thinkingNow={thinkingNow}
      isActive={isActive}
      seconds={seconds}
    >
      {children}
    </TurnProcessDisclosure>
  );
}

function TurnProcessDisclosure({
  identity,
  automaticOpen,
  revealRequest,
  issueCount,
  toolCount,
  thinkingNow,
  isActive,
  seconds,
  children,
}: {
  identity: string;
  automaticOpen: boolean;
  revealRequest?: number;
  issueCount: number;
  toolCount: number;
  thinkingNow: boolean;
  isActive: boolean;
  seconds: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const disclosure = useAutomaticDisclosure(automaticOpen, revealRequest, identity);
  const detailsId = useId();
  return (
    <section className={`turn-process${disclosure.open ? " open" : ""}${isActive ? " active" : ""}`}>
      <button
        type="button"
        ref={disclosure.titleRef}
        className="tool-activity-header"
        aria-expanded={disclosure.open}
        aria-controls={detailsId}
        onClick={disclosure.toggle}
      >
        <span className="tool-activity-icon" aria-hidden>
          <IconSparkles size={14} />
        </span>
        <span className={`tool-activity-label${isActive ? " running" : ""}`}>
          {t(
            isActive
              ? thinkingNow
                ? "chat.thinkingFor"
                : "chat.processingFor"
              : "chat.processedFor",
            { time: formatToolDuration(seconds) },
          )}
        </span>
        {issueCount > 0 ? (
          <span
            className="turn-process-error"
            aria-label={t("chat.activityFailures", { count: issueCount })}
          >
            <IconCircleAlert size={14} aria-hidden />
          </span>
        ) : null}
        {toolCount > 0 ? (
          <span className="tool-activity-count">
            {t("chat.processTools", { count: toolCount })}
          </span>
        ) : null}
        <span className="tool-activity-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      <div
        ref={disclosure.bodyRef}
        id={detailsId}
        className="turn-process-body"
        hidden={!disclosure.open}
        inert={!disclosure.open}
        {...disclosure.bodyEvents}
      >
        <DisclosureCollapseRail label={t("chat.collapseProcess")} onCollapse={disclosure.collapse} />
        <DisclosureScope disclosure={disclosure}>{children}</DisclosureScope>
      </div>
    </section>
  );
}
