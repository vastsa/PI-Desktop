import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningState, UiMessage } from "@pi-desktop/shared";
import { proposalKindForMode } from "@pi-desktop/shared";
import { ConversationMinimap } from "../../../components/ConversationMinimap";
import { PermissionCard } from "../../../components/PermissionCard";
import { TooltipButton } from "../../../components/ui";
import { TurnOutcomeCard } from "../../../components/TurnOutcomeCard";
import { IconArrowDown } from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";
import type { PendingPermission } from "../../../lib/pending-permissions";
import { TRANSCRIPT_SKELETON_ROWS } from "../../../lib/transcript-settle";
import {
  PlanningIndicator,
  RunActivityIndicator,
  WorkingIndicator,
} from "./ActivityGroup";
import { TranscriptHistory, TranscriptTail } from "./AssistantTurn";
import { useTranscriptScroll } from "./hooks/useTranscriptScroll";

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
   * Whether this instance's retained pane is the one on screen (ADR 0137). A
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
  const agentActivity = useAppStore((state) =>
    sessionId ? state.agentStatuses[sessionId]?.activity : undefined,
  );
  const compactions = useAppStore((state) =>
    sessionId ? state.sessionCompactions[sessionId] : undefined,
  );
  const {
    scrollRef,
    wrapRef,
    contentRef,
    historyBoundaryRef,
    loadingOlder,
    showJump,
    historyEntries,
    tailEntry,
    minimapMessages,
    hasEarlierHistory,
    hydrationBounded,
    veilCovering,
    veilPhase,
    handleScroll,
    revealEarlierHistory,
    scrollToBottom,
    jumpToLatest,
  } = useTranscriptScroll({
    sessionId,
    messages,
    compactions,
    hasMoreBefore,
    onLoadOlder,
    isRunning,
    pendingPermission,
    askPending,
    approvalPending,
    planningState,
    paneVisible,
  });

  const lastEntry = tailEntry;
  const lastTurnPart =
    lastEntry?.kind === "assistant-turn" ? lastEntry.parts.at(-1) : undefined;
  const activeToolGroup = isRunning && lastTurnPart?.kind === "activity";
  const assistantIsAnswering =
    lastTurnPart?.kind === "message" &&
    lastTurnPart.message.status === "streaming" &&
    Boolean((lastTurnPart.message.content || "").trim());
  const specializedActivity = agentActivity;
  const hasSpecializedActivity = specializedActivity !== undefined;
  const showRunActivity =
    isRunning &&
    !pendingPermission &&
    !askPending &&
    !approvalPending &&
    !assistantIsAnswering &&
    hasSpecializedActivity;
  // Show immediate feedback after send, then let the concrete activity row
  // (thinking/tool/answer) take over so the transcript never duplicates state.
  const showWorking =
    isRunning &&
    !pendingPermission &&
    !askPending &&
    !approvalPending &&
    planningState !== "planning" &&
    !activeToolGroup &&
    !assistantIsAnswering &&
    !hasSpecializedActivity;
  // Same pre-stream slot as Working: once tools or an answer exist, activity
  // rows carry the live state so a Planning label does not sit orphaned above
  // the composer. The Composer mode chip keeps pulsing for the turn.
  const showPlanning =
    isRunning &&
    planningState === "planning" &&
    !approvalPending &&
    !pendingPermission &&
    !askPending &&
    !activeToolGroup &&
    !assistantIsAnswering &&
    !hasSpecializedActivity;

  return (
    <div
      className="thread-wrap"
      ref={wrapRef}
      data-transcript-settling={veilCovering ? "true" : undefined}
    >
      {/* The minimap measures row positions against a rendered scroller. A
        * hidden pane has none, so measuring there would cache junk offsets and
        * reuse them on reveal. It is out of flow and re-measures on mount, so
        * leaving it out while hidden costs nothing. It also waits for the
        * settle veil to lift: mounting it against still-moving rows would cache
        * offsets the settled layout no longer matches. */}
      {paneVisible && !veilCovering ? (
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
              runtimeActivity={specializedActivity}
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
          {showRunActivity && specializedActivity ? (
            <RunActivityIndicator activity={specializedActivity} />
          ) : null}
          {showPlanning ? <PlanningIndicator kind={planningKind} /> : null}
          {showWorking ? <WorkingIndicator /> : null}
        </div>
      </div>
      {veilPhase !== "off" ? (
        // Positioned without a z-index on purpose: it paints above the scroller
        // in tree order and stays beneath the docked composer, so the user can
        // keep typing while the transcript settles.
        <div
          className="transcript-settle-veil"
          data-phase={veilPhase}
          role="status"
          aria-busy={veilCovering}
          aria-label={t("chat.loadingSession")}
        >
          <div className="transcript-settle-veil-band">
            {TRANSCRIPT_SKELETON_ROWS.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className={`transcript-skeleton-row ${row.role}`}
                aria-hidden
              >
                {row.lines.map((width, lineIndex) => (
                  <span
                    key={lineIndex}
                    className="transcript-skeleton-line"
                    style={{ width }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {showJump && !veilCovering ? (
        <TooltipButton
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
});
