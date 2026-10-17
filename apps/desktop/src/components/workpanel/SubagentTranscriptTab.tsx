import { toolResultPayload } from "../../lib/tool-presentation";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { collectDelegationStatuses, subagentOutcome } from "../../lib/subagent-topology";
import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { IconArrowDown, IconBot, IconChevronDown } from "../icons";
import { Textarea, TooltipButton } from "../ui";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import {
  AssistantErrorMessage,
  ThinkingRow,
} from "../../features/chat/transcript/shared";
import {
  ReviewChangeCard,
} from "../ReviewChangeCard";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { Markdown } from "../Markdown";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";

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
 * The tab allows explicit cancellation; the composer at the foot is a disabled textarea
 * whose placeholder says the delegate is driven by the main agent. There is
 * deliberately no send path.
 */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  return (
    <TranscriptDisclosureProvider key={delegationId}>
      <SubagentTranscriptSurface delegationId={delegationId} />
    </TranscriptDisclosureProvider>
  );
}

function SubagentTranscriptSurface({ delegationId }: { delegationId: string }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  // A tab only renders inside a presented panel, which always has a session;
  // the empty key keeps the hook's contract while nothing is active.
  const transcript = useTranscriptView(activeSessionId ?? "");
  const { messages } = transcript;
  const delegateRunning = useMemo(() => {
    const items = messages
      .filter(message => message.role === "tool")
      .map(message => ({ kind: "tool" as const, message }));
    const statuses = collectDelegationStatuses(items);
    return items.some(({ message }) => {
      const payload = toolResultPayload(message);
      return payload && typeof payload === "object" &&
        "delegationId" in payload && payload.delegationId === delegationId &&
        subagentOutcome(message, statuses) === "running";
    });
  }, [messages, delegationId]);
  const delegateSettings = useMemo(() => {
    const result = messages.find((message) => {
      if (message.role !== "tool") return false;
      const payload = toolResultPayload(message);
      return payload && typeof payload === "object" && !Array.isArray(payload) &&
        "delegationId" in payload && payload.delegationId === delegationId;
    });
    return {
      modelId: result ? delegateModelId(result) : "",
      thinkingLevel: result ? delegateThinkingLevel(result) : undefined,
    };
  }, [messages, delegationId]);
  const isRunning = useAppStore(
    (state) => (activeSessionId ? state.runningSessions[activeSessionId] ?? false : false),
  );
  const transcriptResult = useMemo(
    () => buildSubagentTranscript(messages, delegationId),
    [messages, delegationId],
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
    const focus = transcript.focus;
    if (!focus) return null;
    const claimed = transcriptResult?.turns.some((turn) =>
      turn.rows.some((row) => row.message.id === focus.messageId),
    );
    return claimed ? focus : null;
  }, [transcript.focus, transcriptResult]);

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
                      <Fragment key={row.message.id}>
                        <ToolRow message={row.message} />
                        <ReviewChangeCard message={row.message} />
                      </Fragment>
                    ) : row.kind === "thinking" ? (
                      <ThinkingRow
                        key={`thinking-${row.message.id}`}
                        message={row.message}
                        streaming={isRunning && row.message.status === "streaming"}
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
        <footer className="subagent-transcript-composer">
          <Textarea
            disabled
            rows={2}
            aria-label={t("panel.subagentReadOnly")}
            placeholder={t("panel.subagentReadOnly")}
          />
          <div className="subagent-transcript-composer-controls">
            <button
              type="button"
              className="icon-btn composer-model-thinking-chip subagent-transcript-model-picker"
              disabled
              aria-haspopup="listbox"
              aria-label={`${t("chat.model")}: ${delegateSettings.modelId || "—"}. ${t("chat.reasoningLevel")}: ${delegateSettings.thinkingLevel || "—"}`}
            >
              <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
              <span className="composer-model-thinking-model">{delegateSettings.modelId || "—"}</span>
              <span className="composer-model-thinking-dot" aria-hidden="true">·</span>
              <span className="composer-model-thinking-level">{delegateSettings.thinkingLevel || "—"}</span>
              <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
            </button>
            {delegateRunning ? (
              <SubagentStopButton delegationId={delegationId} running compact />
            ) : null}
          </div>
        </footer>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}
