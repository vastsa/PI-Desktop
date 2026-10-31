import type { SubagentOutcome } from "../../../lib/subagent-topology";
import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { formatToolDuration } from "../../../lib/tool-display";
import { cachedActivitySummary } from "../../../lib/transcript-activity-summary";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import {
  isTurnThinking,
  processContainsMessage,
  turnProcessPhase,
  turnProcessTiming,
} from "../../../lib/turn-process";
import {
  IconChevronRight,
  IconCircleAlert,
  IconSparkles,
} from "../../../components/icons";
import { DisclosureCollapseRail } from "./shared";
import {
  disclosureKey,
  useAutomaticDisclosure,
  type DisclosureScopeValue,
} from "./disclosure";
import { ScopeContext } from "./disclosure-scope";

/**
 * Live stages that rate their own wording.
 *
 * Only stages a reader can sit in front of for a while are listed: compaction
 * and recovery both move real work and both look like a stall without a name.
 * `starting`, `waiting-model` and `preparing` are momentary, so they read as
 * plain running rather than flickering between labels.
 */
const LIVE_PHASE_KEYS: Partial<Record<AgentActivity["phase"], string>> = {
  compacting: "chat.compactingContext",
  recovering: "chat.recoveringTurn",
  retrying: "chat.processRunning",
  "waiting-subagents": "chat.processRunning",
};

/**
 * The whole turn's process, as one disclosure.
 *
 * Every row the turn produced before its answer lives here: the activity groups
 * and the standalone `Bash` run rows alike. That is one top-level collapse for
 * the turn, with the groups and run calls at the level below it, so a long
 * turn reads as "what the agent did" plus the answer instead of a scrolling
 * stack of sibling disclosures.
 *
 * The levels below read this disclosure's scope rather than its choice: closing
 * the process here closes every group under it, and reopening restores the
 * groups the user had opened (see `disclosure.tsx`).
 */
export function TurnProcess({
  turnId,
  processParts,
  turnParts,
  visibleSteps,
  delegationStatuses,
  isActive,
  failed,
  activity,
  children,
}: {
  turnId: string;
  processParts: readonly AssistantTurnPart[];
  turnParts: readonly AssistantTurnPart[];
  /** Visible steps the process reveals; `0` draws no disclosure. */
  visibleSteps: number;
  isActive: boolean;
  /** The turn recorded a failure of its own, so the header must not claim success. */
  failed: boolean;
  /** Live runtime stage, when the runtime reports one. */
  activity?: AgentActivity;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const search = useContext(TranscriptSearchContext);
  const revealRequest = useMemo(() => search && processContainsMessage(processParts, search.messageId)
    ? search.requestId : undefined, [processParts, search]);
  const summary = useMemo(() => cachedActivitySummary(
    processParts.flatMap((part) => part.kind === "activity" ? part.items : []), delegationStatuses,
  ), [processParts, delegationStatuses]);
  const thinkingNow = useMemo(() => isTurnThinking(turnParts, isActive), [turnParts, isActive]);
  // Active processes start open and untouched completed ones close by default;
  // an explicit user choice stays authoritative. This does not depend on the
  // thinking preference, and a recorded failure keeps an untouched active
  // process open through recovery because it stays active until the turn ends.
  const disclosure = useAutomaticDisclosure(
    isActive,
    revealRequest,
    disclosureKey("turn", turnId),
  );
  const detailsId = useId();
  const [now, setNow] = useState(Date.now);
  const { startedAt, endedAt } = useMemo(() => turnProcessTiming(turnParts), [turnParts]);
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  const scope = useMemo<DisclosureScopeValue>(
    () => ({ claim: disclosure.claim, reveal: disclosure.reveal, visible: disclosure.open }),
    [disclosure.claim, disclosure.open, disclosure.reveal],
  );
  // With nothing to reveal there is no disclosure - but the rows still have to
  // render. Hidden reasoning superseded by a separate answer is exactly this
  // case: the reader gets the answer, and the process does not exist.
  if (visibleSteps === 0) return <>{children}</>;
  const seconds = startedAt === undefined ? 0 : Math.max(
    0, Math.floor(((isActive ? now : (endedAt ?? startedAt)) - startedAt) / 1000),
  );
  const elapsed = formatToolDuration(seconds);
  // The header states the turn's outcome and its bounded metadata: status,
  // recorded duration and direct tool count. A shell command can be arbitrarily
  // long, so echoing the current one would push that metadata off the row.
  // `startedAt` is absent for history that recorded no timing, and "0s" would be
  // a lie there, so the duration is dropped instead.
  const hasTiming = startedAt !== undefined && seconds > 0;
  const phase = turnProcessPhase({ parts: turnParts, isActive, failed, activity });
  // The header's label is the status alone. Duration and tool count are separate
  // values so each can be omitted independently, and the caret can follow the
  // last one instead of being pushed to the far edge of the band.
  const label = (() => {
    if (phase.kind === "failed") return t("chat.processFailed");
    if (phase.kind === "stopped") return t("chat.processStopped");
    if (phase.kind === "unsettled") return t("chat.processUnsettled");
    if (phase.kind === "completed") return t("chat.processCompleted");
    // Live: only stages with their own settled wording get their own label. The
    // rest describe an instant at the start of a request, and naming them would
    // make the row flicker instead of telling the reader anything.
    const runningPhase = phase.kind === "running" ? phase.phase : undefined;
    const phaseKey = runningPhase ? LIVE_PHASE_KEYS[runningPhase] : undefined;
    return t(phaseKey ?? (thinkingNow ? "chat.thinking" : "chat.processRunning"));
  })();
  // The summary already counts every activity item it was given, run rows
  // included, so the header must not add them again.
  const toolCount = summary.tools;
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
          {phase.kind === "failed" ? <IconCircleAlert size={14} /> : <IconSparkles size={14} />}
        </span>
        <span className={`tool-activity-label${isActive ? " running" : ""}`}>
          {label}
        </span>
        {isActive ? <span className="activity-marker" aria-hidden /> : null}
        {hasTiming ? (
          <>
            <span className="turn-sep" aria-hidden>·</span>
            <span className="turn-duration">{elapsed}</span>
          </>
        ) : null}
        {toolCount > 0 ? (
          <>
            <span className="turn-sep" aria-hidden>·</span>
            <span className="tool-activity-count">{t("chat.processTools", { count: toolCount })}</span>
          </>
        ) : null}
        <span className="tool-activity-caret" aria-hidden><IconChevronRight size={12} /></span>
      </button>
      <div
        ref={disclosure.bodyRef}
        id={detailsId}
        className="turn-process-body"
        hidden={!disclosure.open}
        inert={!disclosure.open}
        aria-hidden={!disclosure.open}
        {...disclosure.bodyEvents}
      >
        <DisclosureCollapseRail label={t("chat.collapseTurnProcess")} onCollapse={disclosure.collapse} />
        <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
      </div>
    </section>
  );
}
