import type { UiMessage } from "@pi-desktop/shared";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { SubagentMessageComposer } from "../../features/subagents/SubagentMessageComposer";
import { buildSessionSubagents, continuationSubagent } from "../../features/subagents/model";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown } from "../icons";
import { TooltipButton } from "../ui";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { reviewChangeFromMessage } from "../../lib/workspace-review";
import {
  AssistantErrorMessage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import {
  ReviewChangeCard,
} from "../ReviewChangeCard";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { Markdown } from "../Markdown";
import { delegateThinkingLevel } from "../../features/chat/transcript/model";

/**
 * The work-panel tab showing one delegation as a conversation (issue #917).
 *
 * Every `Task` call of the delegation chain opens a turn: the prompt the
 * parent sent renders as a user row, and the rows the delegate produced under
 * that call render with the main transcript's own message-list language —
 * tool rows, thinking rows, and answer bubbles alike. Follow-up `Task` calls
 * on the same delegation append further turns, so a resumed delegate reads as
 * one continuing user/assistant exchange.
 *
 * User commands use the session-scoped controller. Model changes apply to the
 * next user message, without interrupting the delegate's current request.
 */
export function SubagentTranscriptTab({ delegationId, messages, running, draftKey, ready = true, onDelivered }: {
  delegationId: string; messages?: readonly UiMessage[]; running?: boolean;
  draftKey?: string; ready?: boolean; onDelivered?: () => void;
}) {
  return (
    <TranscriptDisclosureProvider key={draftKey ?? delegationId}>
      <SubagentTranscriptSurface delegationId={delegationId} messages={messages} running={running}
        draftKey={draftKey} ready={ready} onDelivered={onDelivered} />
    </TranscriptDisclosureProvider>
  );
}

function SubagentTranscriptSurface({ delegationId, messages: snapshotMessages, running, draftKey, ready, onDelivered }: {
  delegationId: string; messages?: readonly UiMessage[]; running?: boolean;
  draftKey?: string; ready: boolean; onDelivered?: () => void;
}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // A tab only renders inside a presented panel, which always has a session;
  // the empty key keeps the hook's contract while nothing is active.
  const transcript = useTranscriptView(activeSessionId ?? "");
  const messages = snapshotMessages ?? transcript.messages;
  const isRunning = useAppStore(
    (state) => (activeSessionId ? state.runningSessions[activeSessionId] ?? false : false),
  );
  const { selected, chain } = useMemo(() => {
    const agents = buildSessionSubagents(messages, running ?? isRunning);
    const selected = agents.find((agent) => agent.calls.some((call) => delegationIdForMessage(call) === delegationId));
    return { selected, chain: continuationSubagent(agents, selected) };
  }, [messages, delegationId, running, isRunning]);
  const delegateRunning = running ?? chain?.status === "running";
  const latestCall = chain?.calls[chain.calls.length - 1];
  const delegateSettings = {
    modelId: chain?.modelId ?? selected?.modelId ?? "",
    modelKey: chain?.modelKey ?? selected?.modelKey ?? "",
    thinkingLevel: latestCall ? delegateThinkingLevel(latestCall) : undefined,
  };
  const conversationId = chain?.delegationId ?? delegationId;
  const transcriptResult = useMemo(
    () => buildSubagentTranscript(messages, conversationId),
    [messages, conversationId],
  );
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  // Several delegation tabs can be open at once, so an explicit search hit
  // is claimed only by the tab whose own conversation contains the message;
  // the other tabs stay where the reader left them.
  const searchTarget = useMemo(() => {
    const focus = snapshotMessages ? null : transcript.focus;
    if (!focus) return null;
    const claimed = transcriptResult?.turns.some((turn) =>
      turn.rows.some((row) => row.message.id === focus.messageId),
    );
    return claimed ? focus : null;
  }, [transcript.focus, transcriptResult, snapshotMessages]);

  useTranscriptSearchFocus({
    target: searchTarget,
    source:
      messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: messages,
    onNavigate: releaseFollow,
  });

  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
        <div
          ref={scrollRef}
          data-scroll-owner="follow"
          className="subagent-transcript-scroll"
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label={t("panel.subagent")}
          tabIndex={0}
        >
          <div ref={contentRef} className="subagent-transcript-list">
            {transcriptResult ? (
              transcriptResult.turns.map((turn, turnIndex) => (
                <Fragment key={`turn-${turnIndex}`}>
                  <div className="message-row user">
                    <div className="message-col">
                      <div className="message-bubble">
                        <div className="message-user-text selectable">
                          {turn.task || t("panel.subagentTaskEmpty")}
                        </div>
                      </div>
                    </div>
                  </div>
                  {turn.rows.map((row) =>
                    row.kind === "tool" ? (
                      reviewChangeFromMessage(row.message) ? (
                        <ReviewChangeCard
                          key={row.message.id}
                          message={row.message}
                          asToolRow
                        />
                      ) : (
                        <ToolRow key={row.message.id} message={row.message} />
                      )
                    ) : row.kind === "user" ? (
                      <div className="message-row user" data-message-id={row.message.id} key={row.message.id}>
                        <div className="message-col"><div className="message-bubble">
                          <div className="message-user-text selectable">{row.message.content}</div>
                        </div></div>
                      </div>
                    ) : row.kind === "thinking" ? (
                      <ThinkingRow
                        key={`thinking-${row.message.id}`}
                        message={row.message}
                        streaming={delegateRunning && row.message.status === "streaming"}
                        autoOpen
                      />
                    ) : (
                      <div
                        className="message-row assistant"
                        data-message-id={row.message.id}
                        key={`answer-${row.message.id}`}
                      >
                        <div className="message-col">
                          <div className="message-bubble">
                            {row.message.content ? (
                              <div className="prose-chat selectable">
                                <Markdown source={row.message.content} />
                              </div>
                            ) : null}
                            {row.message.error ? (
                              <AssistantErrorMessage message={row.message} />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ),
                  )}
                </Fragment>
              ))
            ) : (
              <div className="subagent-transcript-empty" role="status">
                {t("panel.subagentEmpty")}
              </div>
            )}
          </div>
        </div>
        {showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn subagent-transcript-jump"
            tooltip={t("chat.scrollToBottom")}
            ariaLabel={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
        <SubagentMessageComposer sessionId={activeSessionId ?? ""} delegationId={chain?.delegationId ?? delegationId}
          draftKey={draftKey ?? selected?.key ?? delegationId} running={delegateRunning}
          ready={ready && Boolean(chain?.continuationId) && Boolean(transcriptResult) && !chain?.creating} onDelivered={onDelivered}
          modelId={delegateSettings.modelId} modelKey={delegateSettings.modelKey} thinkingLevel={delegateSettings.thinkingLevel}>
          {delegateRunning ? <SubagentStopButton delegationId={chain?.delegationId ?? delegationId}
            name={transcriptResult?.agentName} running compact /> : null}
        </SubagentMessageComposer>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
