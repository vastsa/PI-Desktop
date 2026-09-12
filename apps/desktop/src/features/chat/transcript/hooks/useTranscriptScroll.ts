import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ContextCompactionMark,
  PlanningState,
  UiMessage,
} from "@pi-desktop/shared";
import type { PendingPermission } from "../../../../lib/pending-permissions";
import {
  buildTranscriptEntries,
  transcriptEntryMessages,
  type TranscriptEntry,
} from "../../../../lib/assistant-turns";
import {
  createTranscriptSettleState,
  reduceTranscriptSettle,
  TRANSCRIPT_VEIL_FADE_MS,
} from "../../../../lib/transcript-settle";
import {
  growTranscriptWindow,
  reduceTranscriptWindow,
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
} from "../../../../lib/transcript-window";
import {
  isRecentScrollGesture,
  reduceTranscriptScroll,
} from "../../../../lib/transcript-scroll";

const HISTORY_REVEAL_THRESHOLD_PX = 120;

type UseTranscriptScrollOptions = {
  sessionId: string | undefined;
  messages: UiMessage[];
  compactions?: ContextCompactionMark[];
  hasMoreBefore: boolean;
  onLoadOlder?: () => Promise<void>;
  isRunning: boolean;
  pendingPermission?: PendingPermission;
  askPending: boolean;
  approvalPending: boolean;
  planningState?: PlanningState;
  paneVisible: boolean;
};

export function useTranscriptScroll({
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
}: UseTranscriptScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyBoundaryRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const wasRunningRef = useRef(isRunning);
  const followFrameRef = useRef(0);
  const prependHeightRef = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // Steady-state cap on mounted history rows (D261). Grows when the user
  // reaches the top of the window; reset per session below.
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW_MIN);
  // Read by `reachTop`, which must stay referentially stable for the scroll
  // listener; the projection it describes is only known later in this render.
  const historyLengthRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // `scrollTo({ behavior: "auto" })` is synchronous. Recording the exact
    // target avoids the following native scroll event being mistaken for a
    // user gesture when the composer or the new turn changes the content
    // height in the same frame.
    if (behavior === "auto") lastScrollTopRef.current = targetTop;
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);

  // A user scroll-up gesture always emits input before its scroll events;
  // programmatic follow scrolling and layout clamps (composer collapse on
  // send, indicator mount/unmount) never do. Track the last real input so
  // `handleScroll` can tell the two apart and never let a clamp between a
  // follow `scrollTo` and its native event release follow mode.
  const markScrollGesture = useCallback((event: Event) => {
    if (
      event.type === "wheel" ||
      event.type === "touchstart" ||
      event.type === "touchmove"
    ) {
      lastScrollGestureAtRef.current = performance.now();
      return;
    }
    if (event.type === "pointerdown") {
      lastScrollGestureAtRef.current = performance.now();
      return;
    }
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "PageUp" ||
        key === "PageDown" ||
        key === "Home" ||
        key === "End" ||
        key === " "
      ) {
        lastScrollGestureAtRef.current = performance.now();
      }
    }
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", markScrollGesture, { passive: true });
    el.addEventListener("touchstart", markScrollGesture, { passive: true });
    el.addEventListener("touchmove", markScrollGesture, { passive: true });
    el.addEventListener("pointerdown", markScrollGesture, { passive: true });
    el.addEventListener("keydown", markScrollGesture, { passive: true });
    return () => {
      el.removeEventListener("wheel", markScrollGesture);
      el.removeEventListener("touchstart", markScrollGesture);
      el.removeEventListener("touchmove", markScrollGesture);
      el.removeEventListener("pointerdown", markScrollGesture);
      el.removeEventListener("keydown", markScrollGesture);
    };
  }, [markScrollGesture]);

  // This instance belongs to one session for its whole lifetime (ADR 0137), so
  // "activation" is its own first layout: settle at the newest turn before the
  // first paint, with no cross-session state to unwind.
  useLayoutEffect(() => {
    cancelFollowScroll();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [cancelFollowScroll, scrollToBottom]);

  // Revisits restore this pane's own position. A hidden scroller can be clamped
  // while its content grows off screen, so the offset is captured on the way out
  // and reapplied during the layout phase that reveals the pane: a pane the user
  // had scrolled up in returns to that offset, a pinned one returns to the
  // bottom, and neither shows an intermediate frame.
  const retainedScrollTopRef = useRef<number | null>(null);
  const wasPaneVisibleRef = useRef(paneVisible);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const becameHidden = wasPaneVisibleRef.current && !paneVisible;
    const becameVisible = !wasPaneVisibleRef.current && paneVisible;
    // The transition is only consumed once there is a scroller to read or
    // position. Committing it before this guard would swallow the edge and lose
    // the offset a pane hidden before its scroller existed should return to.
    if (!el) return;
    wasPaneVisibleRef.current = paneVisible;
    if (becameHidden) {
      cancelFollowScroll();
      retainedScrollTopRef.current = el.scrollTop;
      return;
    }
    if (!becameVisible) return;
    if (pinnedRef.current) {
      scrollToBottom();
      return;
    }
    const retained = retainedScrollTopRef.current;
    if (retained === null) return;
    el.scrollTop = retained;
    lastScrollTopRef.current = retained;
  }, [cancelFollowScroll, paneVisible, scrollToBottom]);

  // A hidden pane must not chase its stream: its scroller has no visible
  // viewport, and the measurements a follow scroll depends on are unreliable
  // while it is out of view. It re-anchors when it is revealed instead.
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  const scheduleFollowScroll = useCallback(() => {
    if (!paneVisibleRef.current) return;
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (paneVisibleRef.current && pinnedRef.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  // Re-pins before the browser paints. A ResizeObserver callback runs after
  // layout and before paint, so a `requestAnimationFrame` requested from it
  // lands in the *next* frame: the current frame painted the grown content
  // unpinned and the next one snapped it back, which read as the transcript
  // twitching whenever a row changed height after mount (D287). Scrolling from
  // inside the callback costs nothing extra (layout is already clean) and
  // cannot resize the observed box, so it never re-triggers the observer.
  const followScrollNow = useCallback(() => {
    if (!paneVisibleRef.current || !pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    // Paging is a reading gesture, so a hidden pane never initiates one.
    if (!paneVisibleRef.current) return;
    if (!el || !hasMoreBefore || loadingOlder || !onLoadOlder) {
      return;
    }
    // Prepending rows changes scrollHeight. Capture the old height so the
    // user's viewport stays anchored to the same message after the page lands.
    prependHeightRef.current = el.scrollHeight;
    setLoadingOlder(true);
    void onLoadOlder().finally(() => setLoadingOlder(false));
  }, [hasMoreBefore, loadingOlder, onLoadOlder]);

  /**
   * Reaching the top escalates in two stages (D261): mount more of what is
   * already loaded, and only fetch an older page once the window covers all of
   * it. Both stages anchor the viewport the same way, because both change
   * scrollHeight above the rows the user is reading.
   */
  const reachTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grown = growTranscriptWindow(windowSize, historyLengthRef.current);
    if (grown !== windowSize) {
      // Mounting rows above the viewport changes scrollHeight exactly the way a
      // fetched page does, so it takes the same anchor.
      prependHeightRef.current = el.scrollHeight;
      setWindowSize(grown);
      return;
    }
    loadOlder();
  }, [loadOlder, windowSize]);

  // Anchors the viewport whenever rows appear above it — a fetched older page
  // (`messages.length`) or a grown mounted window (`windowSize`, D261). Both add
  // height above the reading position, so both are corrected here before paint.
  useLayoutEffect(() => {
    const previousHeight = prependHeightRef.current;
    if (previousHeight === null) return;
    const el = scrollRef.current;
    prependHeightRef.current = null;
    if (!el) return;
    const delta = el.scrollHeight - previousHeight;
    if (delta <= 0) return;
    el.scrollTop += delta;
    lastScrollTopRef.current = el.scrollTop;
  }, [messages.length, windowSize]);



  // Follow the stream only while the user is pinned to the bottom; a manual
  // scroll up pauses following and surfaces the jump-to-latest pill.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX) reachTop();
    const wasPinned = pinnedRef.current;
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned: pinnedRef.current,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    // Only a real gesture (wheel / trackpad / touch / scrollbar / keyboard)
    // releases follow. When the composer collapses or an indicator row
    // unmounts right after send, the browser clamps scrollTop and emits a
    // scroll event that looks like an upward gesture; without this guard it
    // would cancel follow and leave the transcript stuck above the new turn.
    const released =
      transition.releasedFollow &&
      isRecentScrollGesture(
        performance.now(),
        lastScrollGestureAtRef.current,
      );
    if (released) {
      pinnedRef.current = false;
      setShowJump(true);
    } else if (transition.releasedFollow) {
      // Programmatic / layout noise: re-baseline the observed position and
      // keep the follow state unchanged instead of treating it as a user
      // gesture. A pinned transcript re-asserts the bottom; an unpinned one
      // stays unpinned.
      pinnedRef.current = wasPinned;
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setShowJump(transition.showJump);
    }
  }, [cancelFollowScroll, reachTop, scheduleFollowScroll]);

  // Send / retry / regenerate always re-pins follow mode so the new prompt and
  // its stream stay in view, even if the user had scrolled up through history.
  // This must run in the layout phase: the send state is committed before the
  // persisted user-message event arrives, and a passive effect allows one
  // frame where a long transcript can remain at its old/top position.
  useLayoutEffect(() => {
    const turnStarted = isRunning && !wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (!turnStarted || !paneVisible) return;
    cancelFollowScroll();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
    scheduleFollowScroll();
  }, [
    cancelFollowScroll,
    isRunning,
    paneVisible,
    scheduleFollowScroll,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [
    messages,
    isRunning,
    pendingPermission?.requestId,
    askPending,
    approvalPending,
    planningState,
    scheduleFollowScroll,
  ]);

  // Streamed Markdown, expanded activity rows, late images, and diagrams change
  // the content height without a React commit, so pinned follow is kept in sync
  // from the observed layout. The content is observed on its border box: the
  // bottom padding is the composer's published height, and a multi-line draft
  // growing that padding must re-pin too, or the newest turn slides behind the
  // composer until the next commit happens to re-pin it. The content box does
  // not include padding and would miss that change entirely. The scroller is
  // observed as well so a window or work-panel resize keeps the bottom in view.
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(followScrollNow);
    ro.observe(content, { box: "border-box" });
    ro.observe(scroller, { box: "border-box" });
    return () => ro.disconnect();
  }, [followScrollNow]);

  // Streaming tokens are deferred so the full historical transcript tree does
  // not rebuild at the same priority as the tail. The pane's own first commit is
  // never deferred: its content must be on screen in the commit that reveals it,
  // otherwise the reveal shows one empty frame.
  const firstCommitRef = useRef(true);
  const firstCommit = firstCommitRef.current;
  // A retained pane can receive a newer live snapshot while it is hidden. Do
  // not let useDeferredValue reveal its previous frame first; the reveal itself
  // is a navigation boundary and must paint the snapshot selected for it.
  const paneRevealed = paneVisible && !wasPaneVisibleRef.current;
  const deferredMessages = useDeferredValue(messages);
  const deferredCompactions = useDeferredValue(compactions);
  const renderedMessages =
    firstCommit || paneRevealed ? messages : deferredMessages;
  const renderedCompactions =
    firstCommit || paneRevealed ? compactions : deferredCompactions;
  const { entries, visible } = useMemo(
    () => buildTranscriptEntries(renderedMessages, renderedCompactions),
    [renderedMessages, renderedCompactions],
  );
  // Memoized so a re-render that changed no message (jump pill, loading row,
  // window growth) hands `TranscriptHistory` the same array, letting its
  // comparator bail on identity instead of walking every mounted row.
  const allHistoryEntries = useMemo(() => entries.slice(0, -1), [entries]);
  const tailEntry = entries.at(-1);
  // Published for `reachTop`, which is declared above this projection but only
  // runs from a scroll event, long after this render committed.
  historyLengthRef.current = allHistoryEntries.length;

  // Progressive hydration, now scoped to this pane's own first commit
  // (ADR 0137): mount only the bottom portion of the transcript when the pane
  // mounts, then expand to the steady-state window after paint, with a spacer
  // holding the scroll height. Because the instance belongs to one session, the
  // gate is plain local mount state rather than a comparison against whichever
  // session was rendered last.
  //
  // The gate has to be derived during render, not set from an effect. Deciding
  // it from a layout effect mounted the *whole* history first and only then cut
  // it back to the budget, so a long session built its entire DOM, discarded it,
  // and rebuilt it, which is the opposite of what bounding the first commit is
  // for.
  //
  // The expansion target is the mounted window (D261), not the whole history: a
  // paged-in session used to end up with every row mounted for good, retaining
  // its Markdown and highlighting for rows nobody was looking at.
  const [hydrationTick, setHydrationTick] = useState(0);
  const hydrationBounded =
    firstCommit && allHistoryEntries.length > TRANSCRIPT_INITIAL_MOUNT;
  // The bounded commit and the expansion must show the transcript at the same
  // place. A spacer sized from a per-entry guess cannot match the rows it stands
  // in for, so the expansion moved the visible text by the estimate error - the
  // reported page-flip jitter on a session switch. The spacer now only reserves
  // enough height to make the bottom reachable, and the expansion re-pins the
  // exact bottom in the same layout phase it commits in.
  //
  // The "needs re-anchoring" flag is derived from which session was bounded, not
  // written during render: StrictMode double-renders and abandoned concurrent
  // renders would otherwise leave a plain boolean ref set and re-bottom a
  // transcript the user had scrolled up in.
  const boundedFirstCommitRef = useRef(false);
  useEffect(() => {
    if (!hydrationBounded) {
      firstCommitRef.current = false;
      return;
    }
    boundedFirstCommitRef.current = true;
    const frame = requestAnimationFrame(() => {
      firstCommitRef.current = false;
      setHydrationTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(frame);
    // `hydrationTick` is a dependency so a pane whose expansion is still queued
    // re-evaluates instead of holding a stale frame.
  }, [hydrationBounded, hydrationTick]);

  // Settle veil (D287). A bounded first commit means the transcript is long
  // enough for its geometry to keep moving for several frames after mount: the
  // expansion, then rows whose height resolves only once laid out. Rather than
  // painting that motion, an opaque skeleton covers the scroller until the
  // geometry has held still (or a hard time cap passes) and then fades out.
  // Short transcripts mount in one commit and never show the veil. The phase is
  // initialised from the first render's own gate so the veil is in the commit
  // that reveals the pane, not one frame later.
  const [veilPhase, setVeilPhase] = useState<"covering" | "leaving" | "off">(
    () => (hydrationBounded ? "covering" : "off"),
  );
  const veilCovering = veilPhase === "covering";

  const transcriptWindow = reduceTranscriptWindow({
    historyLength: allHistoryEntries.length,
    windowSize,
    initialCommit: hydrationBounded,
  });
  // Memoized so unrelated re-renders (jump pill, loading row) hand
  // `TranscriptHistory` the same array and it can bail on identity instead of
  // walking every mounted row.
  const historyEntries = useMemo(
    () =>
      transcriptWindow.bounded
        ? allHistoryEntries.slice(-transcriptWindow.mounted)
        : allHistoryEntries,
    [allHistoryEntries, transcriptWindow.bounded, transcriptWindow.mounted],
  );

  // Runs in the same layout phase the expansion commits in, before the browser
  // paints it, so mounting the remaining history cannot move the rows the user
  // is already looking at. A user who scrolled up during the bounded frame keeps
  // their position: only a still-pinned transcript is re-bottomed.
  useLayoutEffect(() => {
    if (hydrationBounded || !boundedFirstCommitRef.current) return;
    boundedFirstCommitRef.current = false;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, hydrationBounded, hydrationTick, scrollToBottom]);

  // Sample the scroller once per frame from the expansion commit onward and
  // lift the veil once the geometry has stopped moving. The bounded commit
  // itself is not sampled: the expansion that follows it changes the height by
  // design. Each sample also re-pins a still-pinned transcript, so the frame the
  // veil reveals is already at the newest turn. A hidden pane pauses sampling
  // (its scroller reports no usable geometry) and resumes when revealed.
  useEffect(() => {
    if (!veilCovering || hydrationBounded || !paneVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    let state = createTranscriptSettleState(performance.now());
    let frame = 0;
    const sample = () => {
      frame = 0;
      if (pinnedRef.current) scrollToBottom();
      const step = reduceTranscriptSettle(
        state,
        { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        performance.now(),
      );
      state = step.state;
      if (step.settled) {
        setVeilPhase("leaving");
        return;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [hydrationBounded, paneVisible, scrollToBottom, veilCovering]);

  useEffect(() => {
    if (veilPhase !== "leaving") return;
    const timer = window.setTimeout(
      () => setVeilPhase("off"),
      TRANSCRIPT_VEIL_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [veilPhase]);

  // The minimap must describe the mounted rows, not every loaded message: it
  // resolves a click by looking up the marker's node in the scroller, so a dash
  // for a withheld row would jump nowhere (D261).
  const minimapMessages = useMemo(
    () =>
      transcriptWindow.bounded
        ? transcriptEntryMessages(
            tailEntry ? [...historyEntries, tailEntry] : historyEntries,
          )
        : visible,
    [historyEntries, tailEntry, transcriptWindow.bounded, visible],
  );
  const hasEarlierHistory = transcriptWindow.hiddenAbove > 0 || hasMoreBefore;

  const revealEarlierHistory = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX) {
      reachTop();
      return;
    }
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [cancelFollowScroll, reachTop]);

  const jumpToLatest = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    );
  }, [scrollToBottom]);

  // D269: history progression follows the visible top boundary, not only a
  // native scroll event. A tail page can collapse to less than one viewport,
  // and a fetched page can initially sit outside the mounted window; neither
  // case changes scrollTop, so the old scroll-only trigger could strand both
  // the earlier transcript and the minimap. Re-observing after each window/page
  // transition keeps advancing until the boundary leaves the near-top band or
  // no earlier history remains.
  useEffect(() => {
    const root = scrollRef.current;
    const boundary = historyBoundaryRef.current;
    if (!root || !boundary || !hasEarlierHistory) return;
    // A hidden pane's scroller is unrendered and reports `scrollTop === 0`,
    // which reads as "at the top" and would page history for a session nobody is
    // looking at. The pane re-evaluates when it is revealed, because
    // `paneVisible` is a dependency of this effect.
    if (!paneVisible) return;
    let frame = 0;
    const advanceIfHistoryBoundaryVisible = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          scrollRef.current !== root ||
          root.scrollTop > HISTORY_REVEAL_THRESHOLD_PX
        ) {
          return;
        }
        reachTop();
      });
    };

    // Covers an underfilled tail immediately, including environments without
    // IntersectionObserver; the observer then owns subsequent visibility changes.
    advanceIfHistoryBoundaryVisible();
    if (typeof IntersectionObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          advanceIfHistoryBoundaryVisible();
        }
      },
      {
        root,
        rootMargin: `${HISTORY_REVEAL_THRESHOLD_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(boundary);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `hiddenAbove` is a dependency because an IntersectionObserver does not
    // re-notify while the boundary stays continuously visible: growing the
    // window changes neither `messages.length` nor the intersection state, so
    // without it a still-underfilled transcript would advance exactly once and
    // then stall with loaded rows unmounted. Each re-run performs one bounded
    // growth step, so the escalation stays monotonic and terminates when the
    // window covers the loaded history or the boundary leaves the band.
  }, [
    hasEarlierHistory,
    hydrationTick,
    loadingOlder,
    messages.length,
    paneVisible,
    reachTop,
    sessionId,
    transcriptWindow.hiddenAbove,
  ]);
  return {
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
  };
}
