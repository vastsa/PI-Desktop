import {
  memo,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentActivity,
  ContextCompactionMark,
} from "@pi-desktop/shared";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import {
  reuseReadonlyMap,
  type AssistantTurnEntry,
  type TranscriptEntry,
} from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
} from "../../../lib/subagent-topology";
import {
  segmentTurnProcess,
  type TurnProcessRunSegment,
} from "../../../lib/turn-process";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { resolveTranscriptDisplayMode } from "../../../lib/transcript-display-mode";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { cachedVisibleProcessSteps } from "../../../lib/transcript-activity-summary";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { IconBranch, IconReview } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  CopyButton,
  MessageMeta,
  MessageTimestamp,
} from "./shared";
import { activityItemsEqual } from "./ActivityGroup";
import { GeneratedImages } from "./GeneratedImages";
import { MessageRow } from "./MessageRow";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ToolRow } from "./ToolRow";
import { assistantTurnMenuItems } from "./menu-items";
import {
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";
import {
  getAssistantTurnSummary,
  getAssistantTurnContent,
  reuseReferences,
} from "../../../lib/transcript-summary";
import { AssistantTurnParts } from "./AssistantTurnParts";
import { TurnProcess } from "./TurnProcess";
import { ActionSlotSide } from "./ActionBarSlots";
import { EntryExtraStack } from "./EntryExtraStack";
import { TurnChangesCard } from "./TurnChangesCard";
import { slotMessage } from "../../../plugins/renderer-slots/slot-message";

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  isActive: boolean;
  delegationsLive?: boolean;
  runtimeActivity?: AgentActivity;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (previous.isActive !== next.isActive || previous.delegationsLive !== next.delegationsLive || previous.runtimeActivity !== next.runtimeActivity) return false;
  if (previous.entry === next.entry) return true;
  if (
    previous.entry.id !== next.entry.id ||
    previous.entry.anchorId !== next.entry.anchorId ||
    previous.entry.parts.length !== next.entry.parts.length
  ) {
    return false;
  }
  if (previous.entry.parts === next.entry.parts) return true;
  return previous.entry.parts.every((part, index) => {
    const nextPart = next.entry.parts[index];
    if (part === nextPart) return true;
    if (part.kind !== nextPart.kind) return false;
    if (part.kind === "message" && nextPart.kind === "message") {
      return part.message === nextPart.message;
    }
    if (part.kind === "activity" && nextPart.kind === "activity") {
      return (
        part.endedAt === nextPart.endedAt &&
        part.items.length === nextPart.items.length &&
        (part.items === nextPart.items || part.items.every((item, itemIndex) =>
          activityItemsEqual(item, nextPart.items[itemIndex]),
        ))
      );
    }
    return false;
  });
}

export function compactionMarksEqual(
  previous: ContextCompactionMark,
  next: ContextCompactionMark,
): boolean {
  return (
    previous.id === next.id &&
    previous.throughMessageId === next.throughMessageId &&
    previous.generation === next.generation &&
    previous.summaryTokens === next.summaryTokens &&
    previous.summarized === next.summarized &&
    previous.fallback === next.fallback
  );
}

/** Compare the data that can change a transcript row's rendered output. */
export function transcriptEntryEqual(
  previous: TranscriptEntry,
  next: TranscriptEntry,
): boolean {
  if (previous === next) return true;
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

export function TranscriptEntryView({
  entry,
  isRunning,
  isActive,
  delegationsLive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
  delegationsLive?: boolean;
  runtimeActivity?: AgentActivity;
}) {
  if (entry.kind === "assistant-turn") {
    return (
      <AssistantTurn
        entry={entry}
        isActive={isActive}
        delegationsLive={delegationsLive}
        runtimeActivity={runtimeActivity}
      />
    );
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
  liveDelegations?: ReadonlyMap<string, true>;
  /** The running session's live turn, when it renders inside the history list (#1949). */
  liveTurnId?: string;
};

/**
 * Keep the completed transcript out of the streaming reconciliation path.
 * The projection is still rebuilt for correctness, but React can now bail out
 * before walking every historical row when only the active tail changed. A
 * live turn that is not the tail entry still renders active via `liveTurnId`;
 * its streaming rows rebuild the projection anyway, so the bail-out only ever
 * skips settled rows.
 */
export const TranscriptHistory = memo(function TranscriptHistory({
  entries,
  isRunning,
  liveDelegations,
  liveTurnId,
}: TranscriptHistoryProps) {
  return (
    <>
      {entries.map((entry) => (
        <TranscriptEntryView
          key={transcriptEntryKey(entry)}
          entry={entry}
          isRunning={isRunning}
          isActive={entry.kind === "assistant-turn" && entry.id === liveTurnId}
          delegationsLive={entry.kind === "assistant-turn" && liveDelegations?.has(entry.id)}
        />
      ))}
    </>
  );
}, (previous, next) => {
  if (
    previous.isRunning !== next.isRunning ||
    previous.liveDelegations !== next.liveDelegations ||
    previous.liveTurnId !== next.liveTurnId ||
    previous.entries.length !== next.entries.length
  ) {
    return false;
  }
  if (previous.entries === next.entries) return true;
  return previous.entries.every((entry, index) =>
    transcriptEntryEqual(entry, next.entries[index]),
  );
});

export const TranscriptTail = memo(function TranscriptTail({
  entry,
  isRunning,
  isActive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  return (
    <TranscriptEntryView
      entry={entry}
      isRunning={isRunning}
      isActive={isActive}
      runtimeActivity={runtimeActivity}
    />
  );
}, (previous, next) =>
  previous.isRunning === next.isRunning &&
  previous.isActive === next.isActive &&
  previous.runtimeActivity === next.runtimeActivity &&
  transcriptEntryEqual(previous.entry, next.entry)
);

/**
 * A `Bash`/run call rendered on its own, outside every process and activity
 * disclosure. It stays visible with all disclosures collapsed, and its own
 * detail stays closed until the user opens it.
 */
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

export const AssistantTurn = memo(function AssistantTurn({
  entry,
  isActive,
  delegationsLive,
  runtimeActivity,
}: AssistantTurnProps) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const retryAssistantMessage = useAppStore((s) => s.retryAssistantMessage);
  const forkAssistantMessage = useAppStore((s) => s.forkAssistantMessage);
  const paneSessionId = useSlotSessionId();
  const session = useAppStore((s) => s.sessions.find((item) => item.id === paneSessionId));
  const canEditMessages = sessionAllows(session ?? (paneSessionId.startsWith("remote:") ? { id: paneSessionId } : undefined), "canEditMessages");
  const summary = getAssistantTurnSummary(entry);
  const { actionMessage, metaMessage, latestUsageMessage, usage, responseDurationMs, responseOutputTokens } = summary;
  const modelId = metaMessage?.modelId ?? latestUsageMessage?.modelId;
  const complete = !isActive && !summary.hasError && summary.hasContent && Boolean(actionMessage);
  // A live reply is joined only on menu/copy demand. Finished reply plugins
  // still receive exactly the text that the completed turn's Copy action uses.
  const content = useMemo(
    () => complete ? getAssistantTurnContent(entry) : "",
    [complete, entry],
  );
  const slotReply = useMemo(() => complete && actionMessage
    ? slotMessage("assistant", { ...actionMessage, content }) : undefined,
  [complete, actionMessage, content]);
  const streaming = isActive && summary.streaming;
  // The same preference the nested levels read: hidden reasoning is not a
  // visible step of the turn's process.
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const hideThinking = !showThinking;
  /*
    The turn owns the menu for its whole subtree, the answer rows it renders
    included: Regenerate and Branch act on the turn's answer message, so a menu
    owned by a single message part could not offer them honestly.
  */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    openTranscriptMenu(event, {
      label: t("chat.messageMenu"),
      items: assistantTurnMenuItems({
        t,
        answer: complete ? content : getAssistantTurnContent(entry),
        selectTarget:
          [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              ".message-bubble",
            ),
          ].at(-1) ?? null,
        complete: complete && Boolean(actionMessage) && canEditMessages,
        actions: { copyText, selectText },
        onRegenerate: () => {
          if (actionMessage) void retryAssistantMessage(actionMessage.id);
        },
        onBranch: () => {
          if (actionMessage) void forkAssistantMessage(actionMessage.id);
        },
      }),
    });
  };

  // Collect delegation statuses across ALL activity parts of this turn so that
  // a TaskWait in one part can inform the Task cards in a different part.
  const toolsRef = useRef(summary.tools);
  const tools = reuseReferences(toolsRef.current, summary.tools);
  toolsRef.current = tools;
  const generatedImages = useMemo(() => tools
    .filter((message) => message.toolName === "GenerateImages")
    .map((message) => <GeneratedImages key={message.id} message={message} />), [tools]);
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
  const partContext = { isActive, activePart, runtimeActivity, turnDelegationStatuses, turnDelegationTimings };

  return (
    <div
      className={`message-row assistant assistant-turn${streaming ? " streaming" : ""}`}
      data-minimap-id={entry.anchorId}
      data-row-role="assistant"
      onContextMenu={onContextMenu}
      role="article"
      aria-label={t("chat.assistantMessage")}
    >
      <div className="message-col">
        {process.length > 0 ? (
          <TurnProcess
            turnId={entry.id}
            processParts={process}
            turnParts={entry.parts}
            visibleSteps={visibleSteps}
            isActive={isActive}
            delegationStatuses={turnDelegationStatuses}
            failed={summary.hasError}
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
        {/* Mounted with the reply slots, so a streaming turn never grows it;
            plugin entry extras stay beneath it. */}
        {slotReply ? <TurnChangesCard tools={tools} /> : null}
        {!isActive && metaMessage ? (
          <MessageMeta
            modelId={modelId}
            usage={usage}
            responseDurationMs={responseDurationMs}
            responseOutputTokens={responseOutputTokens}
            responseOutputEstimated={summary.responseOutputEstimated}
          />
        ) : null}
        {complete && actionMessage ? (
          <div className="message-actions">
            <MessageTimestamp createdAt={actionMessage.createdAt} />
            <ActionSlotSide slot="assistantAction" side="left" message={slotReply} />
            <CopyButton text={content} label={t("chat.copy")} />
            {canEditMessages ? <TooltipButton
              className="copy-btn icon"
              tooltip={t("chat.forkResponse")}
              ariaLabel={t("chat.forkResponse")}
              onClick={() => void forkAssistantMessage(actionMessage.id)}
            >
              <IconBranch size={13} />
            </TooltipButton> : null}
            {canEditMessages ? <TooltipButton
              className="copy-btn icon"
              tooltip={t("chat.retry")}
              ariaLabel={t("chat.retry")}
              onClick={() => void retryAssistantMessage(actionMessage.id)}
            >
              <IconReview size={13} />
            </TooltipButton> : null}
            <ActionSlotSide slot="assistantAction" side="right" message={slotReply} />
          </div>
        ) : null}
        {slotReply ? <EntryExtraStack message={slotReply} /> : null}
      </div>
    </div>
  );
}, assistantTurnPropsEqual);

/**
 * The transcript trace of one compaction, matching Codex's `ContextCompaction`
 * turn item: a divider that says the earlier turns above it are now a summary.
 * It carries no actions — nothing about a persisted checkpoint is undoable.
 */
export function CompactionRow({ mark }: { mark: ContextCompactionMark & { summary?: string } }) {
  const { t } = useTranslation();
  return (
    <div className="transcript-compaction-row" role="separator">
      <span className="transcript-compaction-label">
        {t("chat.compactionRow", { times: mark.generation })}
      </span>
      <span className="transcript-compaction-detail" title={mark.summarized && !mark.fallback && mark.summary?.trim() ? mark.summary : undefined}>
        {mark.fallback
          ? t("chat.compactionRowSummaryFailed")
          : mark.summarized
            ? t("chat.compactionRowSummary", {
                tokens: formatCompactTokenCount(mark.summaryTokens),
              })
            : t("chat.compactionRowNoSummary")}
      </span>
    </div>
  );
}
