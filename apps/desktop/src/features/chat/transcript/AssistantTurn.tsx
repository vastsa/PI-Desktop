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
  assistantTurnContent,
  assistantTurnMessages,
  assistantTurnResponseDuration,
  assistantTurnResponseOutputTokens,
  assistantTurnUsage,
  assistantTurnOwnedToolsEqual,
  reuseReadonlyMap,
  subagentRunsEqual,
  type AssistantTurnEntry,
  type AssistantTurnPart,
  type TranscriptEntry,
} from "../../../lib/assistant-turns";
import {
  collectDelegationStatuses,
  collectDelegationTimings,
} from "../../../lib/subagent-topology";
import {
  isLastActivityPart,
  projectTurnProcess,
  resolveThinkingDisplayMode,
  shouldGroupTurnProcess,
  turnProcessTiming,
} from "../../../lib/turn-process";
import { formatMessageTimestamp } from "../../../lib/message-timestamp";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { IconBranch, IconReview } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  AssistantErrorMessage,
  CopyButton,
  MessageMeta,
} from "./shared";
import { activityItemsEqual, ActivityGroup } from "./ActivityGroup";
import { GeneratedImages } from "./GeneratedImages";
import { MessageRow } from "./MessageRow";
import { assistantTurnMenuItems } from "./menu-items";
import {
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";
import { TurnFileSummary } from "./TurnFileSummary";
import { TurnProcess } from "./TurnProcess";

type AssistantTurnProps = {
  entry: AssistantTurnEntry;
  sessionId: string | undefined;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
};

function assistantTurnPropsEqual(
  previous: AssistantTurnProps,
  next: AssistantTurnProps,
) {
  if (
    previous.sessionId !== next.sessionId ||
    previous.isActive !== next.isActive ||
    previous.runtimeActivity !== next.runtimeActivity ||
    previous.entry.startedAt !== next.entry.startedAt ||
    previous.entry.anchorId !== next.entry.anchorId ||
    !assistantTurnOwnedToolsEqual(
      previous.entry.ownedToolMessages,
      next.entry.ownedToolMessages,
    ) ||
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
    if (part.kind === "steering" && nextPart.kind === "steering") {
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
      { entry: previous, sessionId: undefined, isActive: false },
      { entry: next, sessionId: undefined, isActive: false },
    );
  }
  return false;
}

export function TranscriptEntryView({
  entry,
  sessionId,
  isRunning,
  isActive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  sessionId: string | undefined;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  if (entry.kind === "assistant-turn") {
    return (
      <AssistantTurn
        entry={entry}
        sessionId={sessionId}
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
  sessionId: string | undefined;
  isRunning: boolean;
};

/**
 * Keep the completed transcript out of the streaming reconciliation path.
 * The projection is still rebuilt for correctness, but React can now bail out
 * before walking every historical row when only the active tail changed.
 */
export const TranscriptHistory = memo(function TranscriptHistory({
  entries,
  sessionId,
  isRunning,
}: TranscriptHistoryProps) {
  return (
    <>
      {entries.map((entry) => (
        <TranscriptEntryView
          key={transcriptEntryKey(entry)}
          sessionId={sessionId}
          entry={entry}
          isRunning={isRunning}
          isActive={false}
        />
      ))}
    </>
  );
}, (previous, next) => {
  if (
    previous.sessionId !== next.sessionId ||
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
  sessionId,
  isRunning,
  isActive,
  runtimeActivity,
}: {
  entry: TranscriptEntry;
  sessionId: string | undefined;
  isRunning: boolean;
  isActive: boolean;
  runtimeActivity?: AgentActivity;
}) {
  return (
    <TranscriptEntryView
      sessionId={sessionId}
      entry={entry}
      isRunning={isRunning}
      isActive={isActive}
      runtimeActivity={runtimeActivity}
    />
  );
}, (previous, next) =>
  previous.sessionId === next.sessionId &&
  previous.isRunning === next.isRunning &&
  previous.isActive === next.isActive &&
  previous.runtimeActivity === next.runtimeActivity &&
  transcriptEntryEqual(previous.entry, next.entry)
);

export const AssistantTurn = memo(function AssistantTurn({
  entry,
  sessionId,
  isActive,
  runtimeActivity,
}: AssistantTurnProps) {
  const { t, i18n } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
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
  const processTiming = useMemo(
    () => turnProcessTiming(entry.parts, entry.startedAt),
    [entry.parts, entry.startedAt],
  );
  const completedTimestamp = isActive
    ? undefined
    : formatMessageTimestamp(
        processTiming.endedAt,
        i18n.resolvedLanguage ?? i18n.language,
      );
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
        answer: content,
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
  const turnAllActivityItems = useMemo(
    () =>
      entry.parts.flatMap((part) =>
        part.kind === "activity" ? part.items : [],
      ),
    [entry.parts],
  );
  const rawDelegationStatuses = useMemo(
    () =>
      collectDelegationStatuses(turnAllActivityItems, { turnLive: isActive }),
    [turnAllActivityItems, isActive],
  );
  const rawDelegationTimings = useMemo(
    () => collectDelegationTimings(turnAllActivityItems),
    [turnAllActivityItems],
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
  const { process, responses } = projectTurnProcess(entry);
  const activePart = isActive ? entry.parts.at(-1) : undefined;

  const renderPart = (part: AssistantTurnPart) => {
    if (part.kind === "activity") {
      return (
        <ActivityGroup
          embedded
          key={`activity-${part.items[0].message.id}-${part.items[0].kind}${part.items[0].kind === "hostedSearch" ? `-${part.items[0].round.id}` : ""}`}
          items={part.items}
          endedAt={part.endedAt}
          isActive={part === activePart}
          isLast={isLastActivityPart(entry.parts, part)}
          runtimeActivity={part === activePart ? runtimeActivity : undefined}
          turnDelegationStatuses={turnDelegationStatuses}
          turnDelegationTimings={turnDelegationTimings}
        />
      );
    }
    if (part.kind === "steering") {
      return (
        <MessageRow
          embedded
          key={part.message.id}
          message={part.message}
          isRunning={isActive}
        />
      );
    }
    return (
      <div
        className={`message-bubble assistant-turn-fragment${
          isActive && part.message.status === "streaming" ? " streaming" : ""
        }`}
        data-message-id={part.message.id}
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
    );
  };

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
            <TurnProcess
              turnId={entry.id}
              processParts={process}
              turnParts={entry.parts}
              timing={processTiming}
              isActive={isActive}
              delegationStatuses={turnDelegationStatuses}
            >
              {process.map(renderPart)}
            </TurnProcess>
            {responses.map(renderPart)}
          </>
        ) : (
          entry.parts.map(renderPart)
        )}
        {turnAllActivityItems
          .filter(
            (item) =>
              item.kind === "tool" && item.message.toolName === "GenerateImages",
          )
          .map((item) => (
            <GeneratedImages key={item.message.id} message={item.message} />
          ))}
        {!isActive ? <TurnFileSummary entry={entry} sessionId={sessionId} /> : null}
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
            {completedTimestamp ? (
              <time className="message-timestamp" dateTime={completedTimestamp.dateTime}>
                {completedTimestamp.label}
              </time>
            ) : null}
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
