import type { SubagentOutcome } from "../../../lib/subagent-topology";
import { useContext, useEffect, useId, useState, type ReactNode } from "react";
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
  turnProcessTiming,
  visibleProcessSteps,
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
  delegationStatuses,
  isActive,
  children,
}: {
  turnId: string;
  processParts: readonly AssistantTurnPart[];
  turnParts: readonly AssistantTurnPart[];
  isActive: boolean;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const mode = useAppStore((state) => resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode));
  const search = useContext(TranscriptSearchContext);
  const revealRequest = search && processContainsMessage(processParts, search.messageId)
    ? search.requestId : undefined;
  const summary = activitySummary(processParts.flatMap((part) => part.kind === "activity" ? part.items : []), delegationStatuses);
  const thinkingNow = isTurnThinking(turnParts, isActive);
  const disclosure = useAutomaticDisclosure(
    shouldAutoOpenTurnProcess(mode, isActive, summary.issues > 0),
    revealRequest,
    disclosureKey("turn", turnId),
  );
  const detailsId = useId();
  const [now, setNow] = useState(Date.now);
  const { startedAt, endedAt } = turnProcessTiming(turnParts);
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  if (visibleProcessSteps(processParts, mode, isActive) === 0) return null;
  const seconds = startedAt === undefined ? 0 : Math.max(
    0, Math.floor(((isActive ? now : (endedAt ?? startedAt)) - startedAt) / 1000),
  );
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
        <span className="tool-activity-icon" aria-hidden><IconSparkles size={14} /></span>
        <span className={`tool-activity-label${isActive ? " running" : ""}`}>
          {t(isActive ? thinkingNow ? "chat.thinkingFor" : "chat.processingFor" : "chat.processedFor", {
            time: formatToolDuration(seconds),
          })}
        </span>
        {summary.issues > 0 ? (
          <span className="turn-process-error">
            <IconCircleAlert size={14} aria-hidden />
            {t("chat.activityFailures", { count: summary.issues })}
          </span>
        ) : null}
        {summary.tools > 0 ? (
          <span className="tool-activity-count">{t("chat.processTools", { count: summary.tools })}</span>
        ) : null}
        <span className="tool-activity-caret" aria-hidden><IconChevronRight size={12} /></span>
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
