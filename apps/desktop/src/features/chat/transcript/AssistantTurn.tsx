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
  resolveThinkingDisplayMode,
  shouldGroupTurnProcess,
} from "../../../lib/turn-process";
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
import { slotMessage } from "../../../plugins/renderer-slots/slot-message";

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (previous.isActive !== next.isActive || previous.runtimeActivity !== next.runtimeActivity) return false;
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
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  if (entry.kind === "assistant-turn") {
    return (
      <AssistantTurn
        entry={entry}
        isActive={isActive}
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
};

/**
 * Keep the completed transcript out of the streaming reconciliation path.
 * The projection is still rebuilt for correctness, but React can now bail out
 * before walking every historical row when only the active tail changed.
 */
export const TranscriptHistory = memo(function TranscriptHistory({
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

export const AssistantTurn = memo(function AssistantTurn({
  entry,
  isActive,
  runtimeActivity,
}: AssistantTurnProps) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const retryAssistantMessage = useAppStore((s) => s.retryAssistantMessage);
  const forkAssistantMessage = useAppStore((s) => s.forkAssistantMessage);
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
        complete: complete && Boolean(actionMessage),
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
    () => collectDelegationStatuses(delegationItems, { turnLive: isActive }),
    [delegationItems, isActive],
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
  const groupProcess = useAppStore((state) =>
    shouldGroupTurnProcess(
      resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode),
    ),
  );
  const { process, responses, lastActivityPart } = summary;
  const activePart = isActive ? entry.parts.at(-1) : undefined;
  const partContext = { isActive, activePart, lastActivityPart, runtimeActivity, turnDelegationStatuses, turnDelegationTimings };

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
        {groupProcess ? (
          <>
            <TurnProcess turnId={entry.id} processParts={process} turnParts={entry.parts} isActive={isActive} delegationStatuses={turnDelegationStatuses}>
              <AssistantTurnParts parts={process} {...partContext} />
            </TurnProcess>
            <AssistantTurnParts parts={responses} {...partContext} />
          </>
        ) : (
          <AssistantTurnParts parts={entry.parts} {...partContext} />
        )}
        {generatedImages}
        {!isActive && metaMessage ? (
          <MessageMeta
            modelId={modelId}
            usage={usage}
            responseDurationMs={responseDurationMs}
            responseOutputTokens={responseOutputTokens}
          />
        ) : null}
        {complete && actionMessage ? (
          <div className="message-actions">
            <MessageTimestamp createdAt={actionMessage.createdAt} />
            <ActionSlotSide slot="assistantAction" side="left" message={slotReply} />
            <CopyButton text={content} label={t("chat.copy")} />
            <TooltipButton
              className="copy-btn icon"
              tooltip={t("chat.forkResponse")}
              ariaLabel={t("chat.forkResponse")}
              onClick={() => void forkAssistantMessage(actionMessage.id)}
            >
              <IconBranch size={13} />
            </TooltipButton>
            <TooltipButton
              className="copy-btn icon"
              tooltip={t("chat.retry")}
              ariaLabel={t("chat.retry")}
              onClick={() => void retryAssistantMessage(actionMessage.id)}
            >
              <IconReview size={13} />
            </TooltipButton>
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
