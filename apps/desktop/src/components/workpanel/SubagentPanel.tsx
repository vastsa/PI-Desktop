import { useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import {
  buildTranscriptEntries,
  type AssistantActivityItem,
} from "../../lib/assistant-turns";
import {
  collectDelegationFailures,
  collectDelegationStatuses,
  collectDelegationTimings,
  isDelegationActivityItem,
  type DelegationActivityItem,
  type DelegationFailure,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../lib/subagent-topology";
import { toolResultPayload } from "../../lib/tool-presentation";
import type { SubagentPanelSelection } from "../../lib/subagent-panel";
import { useAppStore } from "../../stores/app-store";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { IconArrowDown } from "../icons";
import { TooltipButton } from "../ui";
import { SubagentDetail } from "../ChatTranscript";

function delegationIdForMessage(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const delegationId = (payload as { delegationId?: unknown }).delegationId;
    if (typeof delegationId === "string" && delegationId) return delegationId;
  }
  return message.toolCallId || message.id;
}

type SelectedSubagent = {
  item: DelegationActivityItem;
  turnActivityItems: AssistantActivityItem[];
};

function findSelectedSubagent(
  messages: UiMessage[],
  delegationId: string,
): SelectedSubagent | null {
  const { entries } = buildTranscriptEntries(messages);
  for (const entry of entries) {
    if (entry.kind !== "assistant-turn") continue;
    const turnActivityItems = entry.parts.flatMap((part) =>
      part.kind === "activity" ? part.items : [],
    );
    const item = turnActivityItems.find(
      (candidate): candidate is DelegationActivityItem =>
        isDelegationActivityItem(candidate) &&
        delegationIdForMessage(candidate.message) === delegationId,
    );
    if (item) return { item, turnActivityItems };
  }
  return null;
}

export function SubagentPanel({ selection }: { selection: SubagentPanelSelection }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) =>
    state.activeSessionId === selection.sessionId
      ? state.messages
      : state.retainedTranscripts[selection.sessionId] ?? [],
  );
  const isRunning = useAppStore(
    (state) => state.runningSessions[selection.sessionId] ?? false,
  );
  const selected = useMemo(
    () => findSelectedSubagent(messages, selection.delegationId),
    [messages, selection.delegationId],
  );
  const delegationStatuses = useMemo<ReadonlyMap<string, SubagentOutcome>>(
    () =>
      selected
        ? collectDelegationStatuses(selected.turnActivityItems, {
            turnLive: isRunning,
          })
        : new Map(),
    [isRunning, selected],
  );
  const delegationFailures = useMemo<ReadonlyMap<string, DelegationFailure>>(
    () =>
      selected
        ? collectDelegationFailures(selected.turnActivityItems)
        : new Map(),
    [selected],
  );
  const delegationTimings = useMemo<ReadonlyMap<string, SubagentTiming>>(
    () =>
      selected
        ? collectDelegationTimings(selected.turnActivityItems)
        : new Map(),
    [selected],
  );
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
  } = useFollowScroll();

  useLayoutEffect(() => {
    jumpToLatest();
  }, [jumpToLatest, selection.delegationId]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [messages, scheduleFollowScroll]);

  return (
    <section
      id="subagent-panel"
      className="subagent-panel"
      role="complementary"
      aria-labelledby="subagent-panel-title"
      data-testid="subagent-panel"
    >
      <div
        ref={scrollRef}
        className="subagent-panel-scroll"
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        tabIndex={0}
      >
        <div ref={contentRef}>
          {selected ? (
            <SubagentDetail
              message={selected.item.message}
              {...(selected.item.delegate
                ? { delegate: selected.item.delegate }
                : {})}
              delegationStatuses={delegationStatuses}
              delegationFailures={delegationFailures}
              delegationTimings={delegationTimings}
            />
          ) : (
            <div className="subagent-panel-empty" role="status">
              {t("panel.subagentEmpty")}
            </div>
          )}
        </div>
      </div>
      {showJump ? (
        <TooltipButton
          type="button"
          className="jump-latest-btn subagent-panel-jump"
          tooltip={t("chat.scrollToBottom")}
          ariaLabel={t("chat.scrollToBottom")}
          onClick={jumpToLatest}
        >
          <IconArrowDown size={14} />
        </TooltipButton>
      ) : null}
      <span id="subagent-panel-title" className="sr-only">
        {activeSessionId === selection.sessionId
          ? t("panel.subagent")
          : t("panel.subagentEmpty")}
      </span>
    </section>
  );
}
