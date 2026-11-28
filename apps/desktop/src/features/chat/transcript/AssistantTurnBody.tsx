import { memo, useMemo, useRef } from "react";
import type { AgentActivity } from "@pi-desktop/shared";
import { reuseReadonlyMap, type AssistantTurnEntry } from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
  type SubagentOutcome,
} from "../../../lib/subagent-topology";
import {
  segmentTurnProcess,
  type TurnProcessRunSegment,
} from "../../../lib/turn-process";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { resolveTranscriptDisplayMode } from "../../../lib/transcript-display-mode";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { useAppStore } from "../../../stores/app-store";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { GeneratedImages } from "./GeneratedImages";
import { ToolRow } from "./ToolRow";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { TurnProcess } from "./TurnProcess";
import { getAssistantTurnSummary, reuseReferences } from "../../../lib/transcript-summary";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";

/** A command beside the activity groups, inside the outer process. */
const StandaloneRunRow = memo(function StandaloneRunRow({
  segment,
}: {
  segment: TurnProcessRunSegment;
}) {
  // A review-backed edit is one tool-level row. It cannot become a run row
  // today, but keeping the branch here prevents a future alias from rendering
  // both the file header and the generic tool header.
  const reviewed = reviewChangeFromMessage(segment.item.message) !== null;
  return (
    <div className="turn-run-row" data-run-row="true">
      {reviewed ? (
        <ReviewChangeCard message={segment.item.message} asToolRow />
      ) : (
        <ToolRow imagesInTurn message={segment.item.message} />
      )}
    </div>
  );
});

/** Shared turn content; session actions and reply slots belong to the caller. */
export const AssistantTurnBody = memo(function AssistantTurnBody({
  entry, isActive, delegationsLive, runtimeActivity, outcome,
}: {
  entry: AssistantTurnEntry;
  isActive: boolean;
  delegationsLive?: boolean;
  runtimeActivity?: AgentActivity;
  outcome?: SubagentOutcome;
}) {
  const summary = getAssistantTurnSummary(entry);
  // The same preference the nested levels read: hidden reasoning is not a
  // visible step of the turn's process.
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const hideThinking = !showThinking;
  // Collect delegation statuses across ALL activity parts of this turn so that
  // a TaskWait in one part can inform the Task cards in a different part.
  const toolsRef = useRef(summary.tools);
  const tools = reuseReferences(toolsRef.current, summary.tools);
  toolsRef.current = tools;
  // Delegation status/timing depends on actual tool messages, never on thinking
  // or text and never on a Task's attached child transcript identity.
  const delegationItems = useMemo(() => tools.map((message) => ({ kind: "tool" as const, message })), [tools]);
  const rawDelegationStatuses = useMemo(
    () => collectDelegationStatuses(delegationItems, { turnLive: isActive || delegationsLive === true }),
    [delegationItems, isActive, delegationsLive],
  );
  const rawDelegationTimings = useMemo(
    () => collectDelegationTimings(delegationItems),
    [delegationItems],
  );
  const statusesRef = useRef(rawDelegationStatuses);
  const timingsRef = useRef(rawDelegationTimings);
  const turnDelegationStatuses = reuseReadonlyMap(
    statusesRef.current,
    rawDelegationStatuses,
  );
  const turnDelegationTimings = reuseReadonlyMap(
    timingsRef.current,
    rawDelegationTimings,
    (left, right) =>
      left.startedAt === right.startedAt && left.completedAt === right.completedAt,
  );
  statusesRef.current = turnDelegationStatuses;
  timingsRef.current = turnDelegationTimings;
  const { process, responses } = summary;
  // Read at render time, never at entry-build time: the projection cache is keyed
  // by messages and compactions only, so a grouping decision made there would
  // stay stale until new messages arrived. Segmenting here makes the preference
  // apply on the next paint.
  const displayMode = useAppStore((state) => resolveTranscriptDisplayMode(state.settings));
  const segments = useMemo(
    () => segmentTurnProcess(process, displayMode),
    [process, displayMode],
  );
  // The one disclosure exists if it reveals anything at all. This uses the same
  // helper the activity rows use: progress text counts, completed thinking is
  // hidden under the preference, and a live reasoning indicator still counts.
  // Content facts come from the per-message cache, so a streaming delta reads
  // only its own message body rather than every earlier one.
  const visibleSteps = useMemo(
    () => cachedVisibleProcessSteps(process, hideThinking, isActive),
    [process, hideThinking, isActive],
  );
  // The live tail is the turn's actual last part. A process chunk opens and
  // reports live state only while it owns that part, so a superseded thinking
  // chunk cannot keep a false "Thinking" header once a Bash call or a separate
  // streamed answer takes over the turn.
  const activePart = isActive ? entry.parts.at(-1) : undefined;
  const generatedImages = useMemo(() => tools
    .filter((message) => message.toolName === "GenerateImages")
    .map((message) => <GeneratedImages key={message.id} message={message} />), [tools]);
  const partContext = { isActive, activePart, runtimeActivity, turnDelegationStatuses, turnDelegationTimings };
  return (
    <>
      {process.length > 0 ? (
        <TurnProcess
          turnId={entry.id}
          processParts={process}
          turnParts={entry.parts}
          visibleSteps={visibleSteps}
          isActive={isActive}
          failed={summary.hasError || outcome === "failed" || outcome === "timed_out" || outcome === "denied"}
          stopped={outcome === "stopped" || outcome === "aborted"}
          activity={runtimeActivity}
        >
          {segments.map((segment) => {
            if (segment.kind === "run") {
              return <StandaloneRunRow key={`run-${segment.key}`} segment={segment} />;
            }
            return (
              <AssistantTurnParts key={`process-${segment.key}`} parts={segment.parts} {...partContext} />
            );
          })}
        </TurnProcess>
      ) : null}
      {/* The answer stays outside the process disclosure: it is what the turn
          produced, not part of what it did. */}
      <AssistantTurnParts parts={responses} {...partContext} />
      {generatedImages}
    </>
  );
});
