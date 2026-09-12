import {
  memo,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentActivity,
  ContextCompactionMark,
} from "@pi-desktop/shared";
import {
  assistantTurnContent,
  assistantTurnMessages,
  assistantTurnResponseDuration,
  assistantTurnResponseOutputTokens,
  assistantTurnUsage,
  subagentRunsEqual,
  type AssistantTurnEntry,
  type TranscriptEntry,
} from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
} from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { IconBranch, IconReview } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  AssistantErrorMessage,
  CopyButton,
  MessageMeta,
  formatTokenCount,
} from "./shared";
import { activityItemsEqual, ActivityGroup } from "./ActivityGroup";
import { MessageRow } from "./MessageRow";

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (
    previous.isActive !== next.isActive ||
    previous.runtimeActivity !== next.runtimeActivity ||
    previous.entry.anchorId !== next.entry.anchorId ||
    previous.entry.parts.length !== next.entry.parts.length
  ) {
    return false;
  }
  return previous.entry.parts.every((part, index) => {
    const nextPart = next.entry.parts[index];
    if (part.kind !== nextPart.kind) return false;
    if (part.kind === "message" && nextPart.kind === "message") {
      return part.message === nextPart.message;
    }
    if (part.kind === "activity" && nextPart.kind === "activity") {
      return (
        part.endedAt === nextPart.endedAt &&
        part.items.length === nextPart.items.length &&
        part.items.every((item, itemIndex) =>
          activityItemsEqual(item, nextPart.items[itemIndex]),
        )
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
    previous.summarized === next.summarized
  );
}

/** Compare the data that can change a transcript row's rendered output. */
export function transcriptEntryEqual(
  previous: TranscriptEntry,
  next: TranscriptEntry,
): boolean {
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
  const retryAssistantMessage = useAppStore((s) => s.retryAssistantMessage);
  const forkAssistantMessage = useAppStore((s) => s.forkAssistantMessage);
  const messages = assistantTurnMessages(entry);
  const content = assistantTurnContent(entry);
  const actionMessage = [...messages]
    .reverse()
    .find((message) => (message.content || "").trim());
  const metaMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.modelId ||
        message.usage ||
        message.responseDurationMs ||
        message.responseOutputTokens,
    );
  const latestUsageMessage = [...messages]
    .reverse()
    .find((message) => message.usage);
  const usage = assistantTurnUsage(entry);
  const responseDurationMs = assistantTurnResponseDuration(entry);
  const responseOutputTokens = assistantTurnResponseOutputTokens(entry);
  const modelId = metaMessage?.modelId ?? latestUsageMessage?.modelId;
  const hasError = messages.some((message) => Boolean(message.error));
  const complete =
    !isActive && !hasError && Boolean(content) && Boolean(actionMessage);
  const streaming =
    isActive && messages.some((message) => message.status === "streaming");

  // Collect delegation statuses across ALL activity parts of this turn so that
  // a TaskWait in one part can inform the Task cards in a different part.
  const turnAllActivityItems = useMemo(
    () =>
      entry.parts.flatMap((part) =>
        part.kind === "activity" ? part.items : [],
      ),
    [entry.parts],
  );
  const turnDelegationStatuses = useMemo(
    () =>
      collectDelegationStatuses(turnAllActivityItems, { turnLive: isActive }),
    [turnAllActivityItems, isActive],
  );
  const turnDelegationTimings = useMemo(
    () => collectDelegationTimings(turnAllActivityItems),
    [turnAllActivityItems],
  );

  return (
    <div
      className={`message-row assistant assistant-turn${streaming ? " streaming" : ""}`}
      data-minimap-id={entry.anchorId}
      role="article"
      aria-label={t("chat.assistantMessage")}
    >
      <div className="message-col">
        {entry.parts.map((part, index) =>
          part.kind === "activity" ? (
            <ActivityGroup
              key={`activity-${part.items[0].message.id}`}
              items={part.items}
              endedAt={part.endedAt}
              isActive={isActive && index === entry.parts.length - 1}
              runtimeActivity={runtimeActivity}
              turnDelegationStatuses={turnDelegationStatuses}
              turnDelegationTimings={turnDelegationTimings}
            />
          ) : (
            <div
              className={`message-bubble assistant-turn-fragment${
                isActive && part.message.status === "streaming"
                  ? " streaming"
                  : ""
              }`}
              key={part.message.id}
            >
              {part.message.content ? (
                <div className="prose-chat">
                  <Markdown source={part.message.content} />
                </div>
              ) : null}
              {part.message.error ? (
                <AssistantErrorMessage message={part.message} />
              ) : null}
            </div>
          ),
        )}
        {!isActive && metaMessage ? (
          <MessageMeta
            modelId={modelId}
            usage={usage}
            responseDurationMs={responseDurationMs}
            responseOutputTokens={responseOutputTokens}
          />
        ) : null}
        {(content || hasError) && actionMessage ? (
          <div className="message-actions">
            {complete ? (
              <CopyButton text={content} label={t("chat.copy")} />
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={t("chat.forkResponse")}
                ariaLabel={t("chat.forkResponse")}
                onClick={() => void forkAssistantMessage(actionMessage.id)}
              >
                <IconBranch size={13} />
              </TooltipButton>
            ) : null}
            {complete ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={t("chat.retry")}
                ariaLabel={t("chat.retry")}
                onClick={() => void retryAssistantMessage(actionMessage.id)}
              >
                <IconReview size={13} />
              </TooltipButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}, assistantTurnPropsEqual);

/**
 * The transcript trace of one compaction, matching Codex's `ContextCompaction`
 * turn item: a divider that says the earlier turns above it are now a summary.
 * It carries no actions — nothing about a persisted checkpoint is undoable.
 */
export function CompactionRow({ mark }: { mark: ContextCompactionMark }) {
  const { t } = useTranslation();
  return (
    <div className="transcript-compaction-row" role="separator">
      <span className="transcript-compaction-label">
        {t("chat.compactionRow", { times: mark.generation })}
      </span>
      <span className="transcript-compaction-detail">
        {mark.summarized
          ? t("chat.compactionRowSummary", {
              tokens: formatTokenCount(mark.summaryTokens),
            })
          : t("chat.compactionRowNoSummary")}
      </span>
    </div>
  );
}

