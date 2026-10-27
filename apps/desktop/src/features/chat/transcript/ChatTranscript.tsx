import { memo, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PlanningState, RadialMenuAction, UiMessage } from "@pi-desktop/shared";
import { proposalKindForMode } from "@pi-desktop/shared";
import { ConversationMinimap } from "../../../components/ConversationMinimap";
import { RadialMenu, type RadialMenuSlot } from "../../../components/RadialMenu";
import { PermissionCard } from "../../../components/PermissionCard";
import { TooltipButton } from "../../../components/ui";
import { TurnOutcomeCard } from "../../../components/TurnOutcomeCard";
import {
  IconArrowDown,
  IconArrowUp,
  IconBrowser,
  IconChat,
  IconCopy,
  IconFolder,
  IconPanel,
  IconTextSelect,
} from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";
import type { PendingPermission } from "../../../lib/pending-permissions";
import { TRANSCRIPT_SKELETON_ROWS } from "../../../lib/transcript-settle";
import {
  PlanningIndicator,
  RunActivityIndicator,
  WorkingIndicator,
} from "./ActivityGroup";
import { TranscriptHistory, TranscriptTail } from "./AssistantTurn";
import { collectLiveDelegationEntries } from "../../../lib/live-delegation-entries";
import { reuseReadonlyMap } from "../../../lib/assistant-turns";
import { useTranscriptScroll } from "./hooks/useTranscriptScroll";
import { useTranscriptContinuation } from "../../../hooks/use-transcript-continuation";
import type { TranscriptSearchTarget } from "../../../lib/transcript-reading";
import type { RestoreTranscriptReading } from "../../../hooks/use-transcript-reading-position";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import { DisclosureAnchorContext } from "../../../lib/disclosure-anchor-context";
import { api } from "../../../lib/api";
import { mergeLiveSessionMessages } from "../../../lib/session-transcript";
import { conversationPlainText } from "../../../lib/chat-transcript-text";
import {
  TranscriptMenuProvider,
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";
import { conversationMenuItems, hasConversationToCopy } from "./menu-items";
import { browserPluginTab } from "../../../lib/work-panel-tabs";
import { isRemoteSession } from "../../../lib/remote-session-safety";
import {
  RADIAL_MENU_ACTION_LABEL_KEYS,
  RADIAL_MENU_DIRECTIONS,
  resolveRadialMenu,
} from "../../../lib/radial-menu";
import { SlotSessionProvider } from "../../../plugins/renderer-slots/use-slots";

type ChatTranscriptProps = {
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
  searchTarget?: TranscriptSearchTarget | null;
  readingWindow?: boolean;
  /** The displayed range includes this session's canonical live tail. */
  liveTail?: boolean;
  onRestoreReading?: RestoreTranscriptReading;
  hasMoreAfter?: boolean;
  onLoadNewer?: () => Promise<void>;
  onReturnToLatest?: () => void;
  navigationLoading?: boolean;
};

/**
 * The transcript facade only mounts the right-click menu provider: the
 * scroller's own background menu has to consume that context, and a component
 * cannot read a provider it renders itself.
 */
export const ChatTranscript = memo(function ChatTranscript(
  props: ChatTranscriptProps,
) {
  return (
    <TranscriptMenuProvider>
      <TranscriptBody {...props} />
    </TranscriptMenuProvider>
  );
});

function TranscriptBody({
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
  searchTarget = null,
  readingWindow = false,
  liveTail = !readingWindow,
  onRestoreReading,
  hasMoreAfter = false,
  onLoadNewer,
  onReturnToLatest,
  navigationLoading = false,
}: ChatTranscriptProps) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const showToast = useAppStore((state) => state.showToast);
  const radialMenu = resolveRadialMenu(
    useAppStore((state) => state.settings),
  );
  const sessionSummary = useAppStore((state) =>
    sessionId
      ? state.sessions.find((session) => session.id === sessionId)
      : undefined,
  );
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const openWorkPanel = useAppStore((state) => state.openWorkPanel);
  const collapseWorkPanel = useAppStore((state) => state.collapseWorkPanel);
  const workPanelOpen = useAppStore((state) => state.workPanelOpen);
  /*
    The ring is a second presentation of the background menu, not a second
    menu: it opens at the pointer and keeps the same conversation-level actions.
  */
  const [radialPoint, setRadialPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const transcriptRunning = isRunning && liveTail;
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
    releaseFollow,
    jumpToLatest,
    disclosureAnchorNotifier,
  } = useTranscriptScroll({
    sessionId,
    messages,
    compactions,
    hasMoreBefore,
    onLoadOlder,
    // Rejoining live output is not a new turn: keep the reader's scroll owner.
    isRunning: isRunning && !readingWindow,
    pendingPermission,
    askPending,
    approvalPending,
    planningState,
    paneVisible,
    searchTarget,
    readingWindow,
    onRestoreReading,
  });

  const continuationCursor = useAppStore((state) =>
    sessionId ? state.transcriptViews[sessionId]?.messageEnd : undefined,
  );
  const automaticContinuation = readingWindow && !searchTarget;
  useTranscriptContinuation({
    scrollRef, contentRef, messages, onLoadNewer,
    enabled: automaticContinuation && hasMoreAfter && paneVisible && !veilCovering,
    cursor: continuationCursor,
    loading: navigationLoading,
  });

  const specializedActivity = agentActivity;
  const rawLiveDelegations = useMemo(
    () => collectLiveDelegationEntries(historyEntries, tailEntry, transcriptRunning),
    [historyEntries, tailEntry, transcriptRunning],
  );
  const liveDelegationsRef = useRef(rawLiveDelegations);
  const liveDelegations = reuseReadonlyMap(liveDelegationsRef.current, rawLiveDelegations);
  liveDelegationsRef.current = liveDelegations;
  const hasSpecializedActivity = specializedActivity !== undefined;
  // Existing output does not mean the turn has finished: a text stream can
  // pause, and completed tool rows can outlive their activity. Keep one tail
  // status until the turn ends or a user interaction owns the pending state.
  const showStatus =
    transcriptRunning &&
    !pendingPermission &&
    !askPending &&
    !approvalPending;
  const showRunActivity = showStatus && hasSpecializedActivity;
  const showWorking =
    showStatus &&
    planningState !== "planning" &&
    !hasSpecializedActivity;
  const showPlanning =
    showStatus &&
    planningState === "planning" &&
    !hasSpecializedActivity;

  // The tail status lane is part of the layout for the whole running turn: the
  // indicators below mount and clear with the turn's phase, and a lane that
  // came and went with them would resize `.thread-content` and push the rows
  // the user is already reading (issue #323). An idle transcript renders no
  // lane at all, so a finished transcript keeps its exact layout.
  const runtimeStatusLane = transcriptRunning;

  /*
    The background menu answers the right-clicks no row claimed: the space below
    the last turn, a system row, a permission or outcome card. It reads the
    conversation rather than one message, so it is the only surface that can
    copy the whole thread.
  */
  const copyConversation = async () => {
    if (!sessionId) return;
    try {
      // Explicit copy reads the full session without changing the reading window.
      const { session } = await api.getSession(sessionId);
      if (!session) throw new Error("Session unavailable");
      await copyText(conversationPlainText(
        mergeLiveSessionMessages(session.messages ?? [], messages),
        { user: t("chat.speakerYou"), assistant: t("chat.speakerAssistant") },
      ));
    } catch {
      showToast(t("chat.copyFailed"), { variant: "error" });
    }
  };

  /*
    Both copy predicates are read only where a menu is built: the background
    menu on right-click and the ring when it opens. Computing them on every
    transcript update would read every historical body for a disabled or
    unopened menu.
  */
  const canCopyConversation = () => hasConversationToCopy({
    sessionId,
    hasMoreBefore,
    hasMoreAfter,
    messages,
  });

  /*
    The newest settled answer, for the ring's optional copy slot. Read lazily:
    the ring builds its items only when it opens, so an unopened or disabled
    ring must not scan historical message bodies on every transcript update.
  */
  const findLastAnswer = (): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && message.content.trim()) {
        return message.content;
      }
    }
    return "";
  };

  /*
    One slot per direction, in ring order. An action the conversation cannot
    fill (no answer yet, or the `none` placeholder) keeps its sector disabled
    so the geometry does not depend on message state.
  */
  const buildRadialMenuItems = (): RadialMenuSlot[] => {
    const copyable = canCopyConversation();
    return RADIAL_MENU_DIRECTIONS.map((direction) => {
      const action: RadialMenuAction = radialMenu.slots[direction];
      const id = `${direction}:${action}`;
      const label = t(RADIAL_MENU_ACTION_LABEL_KEYS[action]);
      switch (action) {
        case "copy-conversation":
          return {
            id,
            label,
            icon: <IconCopy size={18} />,
            disabled: !copyable,
            onSelect: () => void copyConversation(),
          };
        case "select-conversation":
          return {
            id,
            label,
            icon: <IconTextSelect size={18} />,
            onSelect: () => selectText(contentRef.current),
          };
        case "copy-last-answer": {
          const lastAnswer = findLastAnswer();
          return {
            id,
            label,
            icon: <IconChat size={18} />,
            disabled: !lastAnswer,
            onSelect: () => void copyText(lastAnswer),
          };
        }
        case "scroll-top":
          return {
            id,
            label,
            icon: <IconArrowUp size={18} />,
            onSelect: () => scrollRef.current?.scrollTo({ top: 0 }),
          };
        case "scroll-bottom":
          return {
            id,
            label,
            icon: <IconArrowDown size={18} />,
            onSelect: () => {
              onReturnToLatest?.();
              jumpToLatest();
            },
          };
        case "open-browser":
          return {
            id,
            label,
            icon: <IconBrowser size={18} />,
            disabled: !sessionId || isRemoteSession(sessionSummary),
            onSelect: () => openWorkPanelTab(browserPluginTab()),
          };
        case "open-work-panel":
          // One direction, two directions of travel: an open panel offers the
          // way back instead of a second no-op Open.
          return {
            id,
            label: workPanelOpen
              ? t("chat.radialMenuCloseWorkPanel")
              : label,
            icon: <IconPanel size={18} />,
            disabled: !sessionId || isRemoteSession(sessionSummary),
            onSelect: () => (workPanelOpen ? collapseWorkPanel() : openWorkPanel()),
          };
        case "open-project-folder": {
          const path = sessionSummary?.projectPath;
          return {
            id,
            label,
            icon: <IconFolder size={18} />,
            disabled: !path || isRemoteSession(sessionSummary),
            onSelect: () => {
              if (!path) return;
              void api.openProjectFolder(path).catch((error: unknown) => {
                showToast(
                  error instanceof Error ? error.message : String(error),
                  { variant: "error" },
                );
              });
            },
          };
        }
        default:
          return { id, label, icon: <IconChat size={18} />, disabled: true, onSelect: () => {} };
      }
    });
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (radialMenu.enabled) {
      event.preventDefault();
      event.stopPropagation();
      setRadialPoint({ x: event.clientX, y: event.clientY });
      return;
    }
    openTranscriptMenu(event, {
      label: t("chat.conversationMenu"),
      items: conversationMenuItems({
        t,
        canCopy: canCopyConversation(),
        onCopyConversation: () => void copyConversation(),
        scrollRef,
        contentRef,
        actions: { copyText, selectText },
        onReturnToLatest: () => {
          onReturnToLatest?.();
          jumpToLatest();
        },
      }),
    });
  };

  return (
    <TranscriptSearchContext.Provider value={searchTarget}>
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
    <SlotSessionProvider sessionId={sessionId ?? ""}>
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
          onReleaseFollow={releaseFollow}
        />
      ) : null}
      <div
        className="thread-scroll"
        ref={scrollRef}
        data-scroll-owner="transcript"
        onContextMenu={onContextMenu}
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
          <TranscriptHistory entries={historyEntries} isRunning={isRunning} liveDelegations={liveDelegations} />
          {tailEntry ? (
            <TranscriptTail
              entry={tailEntry}
              isRunning={isRunning}
              isActive={transcriptRunning && tailEntry.kind === "assistant-turn"}
              runtimeActivity={specializedActivity}
            />
          ) : null}
          {hasMoreAfter && !automaticContinuation ? (
            <button
              type="button"
              className="transcript-load-later"
              disabled={navigationLoading}
              onClick={() => void onLoadNewer?.()}
            >
              {t("chat.loadLaterMessages")}
            </button>
          ) : null}
          {liveTail ? (
            <TurnOutcomeCard
              messages={messages}
              result={latestTurnResult}
            />
          ) : null}
          {pendingPermission ? (
            <PermissionCard
              key={pendingPermission.requestId}
              permission={pendingPermission}
              queued={queuedPermissions}
            />
          ) : null}
          {runtimeStatusLane ? (
            <div className="transcript-runtime-status">
              {showRunActivity && specializedActivity ? (
                <RunActivityIndicator activity={specializedActivity} />
              ) : null}
              {showPlanning ? <PlanningIndicator kind={planningKind} /> : null}
              {showWorking ? <WorkingIndicator /> : null}
            </div>
          ) : null}
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
      {navigationLoading ? (
        <div className="transcript-navigation-loading" role="status">{t("chat.loadingSession")}</div>
      ) : null}
      {(showJump || readingWindow) && !veilCovering ? (
        <TooltipButton
          className="jump-latest-btn"
          ariaLabel={t("chat.scrollToBottom")}
          tooltip={t("chat.scrollToBottom")}
          onClick={() => {
            onReturnToLatest?.();
            jumpToLatest();
          }}
        >
          <IconArrowDown size={14} />
        </TooltipButton>
      ) : null}
    </div>
    {radialPoint ? (
      <RadialMenu
        point={radialPoint}
        items={buildRadialMenuItems()}
        label={t("chat.conversationMenu")}
        onClose={() => setRadialPoint(null)}
      />
    ) : null}
    </SlotSessionProvider>
    </DisclosureAnchorContext.Provider>
    </TranscriptSearchContext.Provider>
  );
}
