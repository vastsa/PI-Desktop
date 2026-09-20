import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { formatToolDuration } from "../../../lib/tool-display";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import {
  hasFailedProcessTool,
  isTurnThinking,
  processContainsMessage,
  resolveThinkingDisplayMode,
  shouldAutoOpenTurnProcess,
  turnProcessTiming,
  visibleProcessSteps,
} from "../../../lib/turn-process";
import { useAppStore } from "../../../stores/app-store";
import {
  IconChevronRight,
  IconCircleAlert,
  IconSparkles,
} from "../../../components/icons";
import { DisclosureCollapseRail, useAutomaticDisclosure } from "./shared";

export function TurnProcess({
  processParts,
  turnParts,
  isActive,
  children,
}: {
  processParts: readonly AssistantTurnPart[];
  turnParts: readonly AssistantTurnPart[];
  isActive: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const mode = useAppStore((state) =>
    resolveThinkingDisplayMode(state.settings?.thinkingDisplayMode),
  );
  const search = useContext(TranscriptSearchContext);
  const revealRequest =
    search && processContainsMessage(processParts, search.messageId)
      ? search.requestId
      : undefined;
  const hasToolFailure = hasFailedProcessTool(processParts);
  const thinkingNow = isTurnThinking(turnParts, isActive);
  const disclosure = useAutomaticDisclosure(
    shouldAutoOpenTurnProcess(mode, isActive, hasToolFailure),
    revealRequest,
  );
  const detailsId = useId();
  const [now, setNow] = useState(Date.now);
  const { startedAt, endedAt } = turnProcessTiming(turnParts);
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  const count = visibleProcessSteps(processParts, mode, isActive);
  if (count === 0) return null;
  const seconds =
    startedAt === undefined
      ? 0
      : Math.max(
          0,
          Math.floor(((isActive ? now : (endedAt ?? startedAt)) - startedAt) / 1000),
        );
  return (
    <section
      className={`turn-process${disclosure.open ? " open" : ""}${isActive ? " active" : ""}`}
    >
      <button
        type="button"
        ref={disclosure.titleRef}
        className="tool-activity-header"
        aria-expanded={disclosure.open}
        aria-controls={detailsId}
        onClick={disclosure.toggle}
      >
        <span className="tool-activity-icon" aria-hidden>
          <IconSparkles size={14} />
        </span>
        <span className={`tool-activity-label${isActive ? " running" : ""}`}>
          {t(
            isActive
              ? thinkingNow
                ? "chat.thinkingFor"
                : "chat.processingFor"
              : "chat.processedFor",
            { time: formatToolDuration(seconds) },
          )}
        </span>
        {hasToolFailure ? (
          <span className="turn-process-error" title={t("chat.toolFailed")}>
            <IconCircleAlert size={14} aria-label={t("chat.toolFailed")} />
          </span>
        ) : null}
        <span className="tool-activity-count">
          {t("chat.processingSteps", { count })}
        </span>
        <span className="tool-activity-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      <div
        id={detailsId}
        className="turn-process-body"
        hidden={!disclosure.open}
        inert={!disclosure.open}
        onClickCapture={disclosure.claim}
      >
        <DisclosureCollapseRail
          label={t("chat.collapseDetails")}
          onCollapse={disclosure.collapse}
        />
        {children}
      </div>
    </section>
  );
}
