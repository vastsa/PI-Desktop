import {
  useCallback,
  useReducer,
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
  reuseTranscriptEntries,
  transcriptEntryMessages,
  type TranscriptEntry,
} from "../../../../lib/assistant-turns";
import {
  createTranscriptSettleState,
  reduceTranscriptSettle,
  TRANSCRIPT_VEIL_FADE_MS,
} from "../../../../lib/transcript-settle";
import {
  reduceTranscriptWindow,
  TRANSCRIPT_INITIAL_MOUNT,
} from "../../../../lib/transcript-window";
import {
  HISTORY_REVEAL_THRESHOLD_PX,
  isHistoryRevealPosition,
  isRecentScrollGesture,
  isScrollGestureInput,
  reduceTranscriptScroll,
  transcriptHasLayout,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  type ScrollInputType,
} from "../../../../lib/transcript-scroll";
import { readScrollInputContext } from "../../../../lib/scroll-input";
import { useDisclosureAnchor } from "../../../../hooks/use-disclosure-anchor";
import type { TranscriptSearchTarget } from "../../../../lib/transcript-reading";
import { useTranscriptSearchFocus } from "../../../../hooks/use-transcript-search-focus";

import { useTranscriptPrepend } from "./useTranscriptPrepend";
import { useTranscriptProjection } from "./useTranscriptProjection";

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
  searchTarget: TranscriptSearchTarget | null;
  readingWindow: boolean;
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
  searchTarget,
  readingWindow,
}: UseTranscriptScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyBoundaryRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // Last offset sampled while the scroller had a real layout box. A hidden
  // pane's `content-visibility: hidden` box reports `scrollTop === 0`, so the
  // hide transition must restore this rather than the collapsed value.
  const lastLaidOutScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const wasRunningRef = useRef(isRunning);
  const followFrameRef = useRef(0);
  const pendingLatestRef = useRef(false);
  const [latestRevision, requestLatestCommit] = useReducer((revision: number) => revision + 1, 0);
  const [showJump, setShowJump] = useState(false);
  const setPinned = useCallback((pinned: boolean) => {
    pinnedRef.current = pinned;
    scrollRef.current?.classList.toggle("transcript-pinned", pinned);
  }, []);

  const previousEntriesRef = useRef<TranscriptEntry[]>([]);
  const previousSessionIdRef = useRef(sessionId);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // `scrollTo({ behavior: "auto" })` is synchronous. Record the position the
    // scroller actually reached, not the one that was asked for: at a
    // fractional device pixel ratio the browser lands a fraction of a pixel
    // away (asked 841, got 840.909), and the intended value would make the
    // following native scroll event read as the user scrolling up.
    if (behavior === "auto") {
      lastScrollTopRef.current = el.scrollTop;
      lastLaidOutScrollTopRef.current = el.scrollTop;
    }
  }, []);

  const positionAtFoldedBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    el.classList.add("transcript-measure-folded");
    try {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    } finally {
      el.classList.remove("transcript-measure-folded");
    }
    const settled = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop !== settled) el.scrollTop = settled;
    lastScrollTopRef.current = el.scrollTop;
    lastLaidOutScrollTopRef.current = el.scrollTop;
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);

  const recordScrollPosition = useCallback((top: number) => {
    lastScrollTopRef.current = top;
    lastLaidOutScrollTopRef.current = top;
  }, []);
  const {
    windowSize, loadingOlder, revision: prependRevision, reachTop,
    invalidate: invalidatePrepend, commit: commitPrepend,
    reanchor: reanchorPrepend,
  } = useTranscriptPrepend({
    scrollRef, paneVisible, sessionId, searchRequestId: searchTarget?.requestId,
    readingWindow, hasMoreBefore, onLoadOlder, onPosition: recordScrollPosition,
  });

  // A manual disclosure (a tool, thinking or activity title; #324) hands this
  // scroller the very title it was toggled from, before the expansion state
  // changes. Follow mode is left first — re-bottoming the expansion is exactly
  // what dragged the clicked title out of view — and the held position is
  // restored from the observer below for every frame of the height transition.
  const enterDisclosureReading = useCallback(() => {
    cancelFollowScroll();
    setPinned(false);
    setShowJump(true);
  }, [cancelFollowScroll, setPinned]);
  const {
    notifier: disclosureAnchorNotifier,
    restore: restoreDisclosureAnchor,
    release: releaseDisclosureAnchor,
    isHeld: isDisclosureAnchorHeld,
  } = useDisclosureAnchor(
    scrollRef,
    enterDisclosureReading,
    recordScrollPosition,
  );
  const restoreHeldDisclosure = useCallback(() => {
    if (!restoreDisclosureAnchor()) return false;
    // The held title owns this geometry. A pending read keeps its request but
    // adopts the achieved position instead of later undoing the disclosure.
    reanchorPrepend();
    return true;
  }, [reanchorPrepend, restoreDisclosureAnchor]);

  // A user scroll-up gesture always emits input before its scroll events;
  // programmatic follow scrolling and layout clamps (composer collapse on
  // send, indicator mount/unmount) never do. Track the last real input so
  // `handleScroll` can tell the two apart and never let a clamp between a
  // follow `scrollTo` and its native event release follow mode. Only input
  // that can move *this* scroller counts: a press on a row control is an
  // ordinary click, a field owns its own keys, and a gesture a nested dock
  // consumes belongs to that dock.
  const markScrollGesture = useCallback(
    (event: Event) => {
      // The settle veil and minimap are siblings of the scroll container.
      // Their wheel input cannot scroll it and must not release bottom follow.
      if (!(event.target instanceof Node) || !scrollRef.current?.contains(event.target)) return;
      const input = readScrollInputContext(
        event,
        scrollRef.current,
        contentRef.current,
      );
      if (!isScrollGestureInput(event.type as ScrollInputType, input)) return;
      lastScrollGestureAtRef.current = performance.now();
      if (isDisclosureAnchorHeld()) reanchorPrepend();
      releaseDisclosureAnchor();
      const scrollingUp =
        (event instanceof WheelEvent && event.deltaY < 0) ||
        (event instanceof KeyboardEvent &&
          (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home")) ||
        (event.type === "pointerdown" && event.target === scrollRef.current);
      // Cancel a pending bottom pin once upward intent belongs to this scroller.
      if (scrollingUp) {
        cancelFollowScroll();
        setPinned(false);
      }
    },
    [cancelFollowScroll, isDisclosureAnchorHeld, reanchorPrepend, releaseDisclosureAnchor, setPinned],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Capture phase runs before the browser applies the wheel, so follow is
    // already released when that first upward gesture scrolls.
    const options = { passive: true, capture: true } as const;
    el.addEventListener("wheel", markScrollGesture, options);
    el.addEventListener("touchstart", markScrollGesture, options);
    el.addEventListener("touchmove", markScrollGesture, options);
    el.addEventListener("pointerdown", markScrollGesture, options);
    el.addEventListener("keydown", markScrollGesture, options);
    return () => {
      el.removeEventListener("wheel", markScrollGesture, options);
      el.removeEventListener("touchstart", markScrollGesture, options);
      el.removeEventListener("touchmove", markScrollGesture, options);
      el.removeEventListener("pointerdown", markScrollGesture, options);
      el.removeEventListener("keydown", markScrollGesture, options);
    };
  }, [markScrollGesture]);

  // This instance belongs to one session for its whole lifetime (ADR 0137), so
  // "activation" is its own first layout: settle at the newest turn before the
  // first paint, with no cross-session state to unwind.
  useLayoutEffect(() => {
    releaseDisclosureAnchor();
    cancelFollowScroll();
    setPinned(true);
    setShowJump(false);
    positionAtFoldedBottom();
  }, [cancelFollowScroll, positionAtFoldedBottom, releaseDisclosureAnchor]);

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
      releaseDisclosureAnchor();
      cancelFollowScroll();
      // Do not read `el.scrollTop` here: the hide CSS has already skipped
      // rendering, so the box reports 0. Restore the last laid-out offset.
      retainedScrollTopRef.current = lastLaidOutScrollTopRef.current;
      return;
    }
    if (!becameVisible) return;
    if (pinnedRef.current) {
      positionAtFoldedBottom();
      return;
    }
    const retained = retainedScrollTopRef.current;
    if (retained === null) return;
    el.scrollTop = retained;
    recordScrollPosition(el.scrollTop);
  }, [cancelFollowScroll, paneVisible, positionAtFoldedBottom, recordScrollPosition, releaseDisclosureAnchor]);

  // A hidden pane must not chase its stream: its scroller has no visible
  // viewport, and the measurements a follow scroll depends on are unreliable
  // while it is out of view. It re-anchors when it is revealed instead.
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  const scheduleFollowScroll = useCallback(() => {
    if (!paneVisibleRef.current) return;
    // A held disclosure position wins over a queued follow frame: re-asserting
    // the bottom here would move the title the reader just toggled even though
    // the observer below already refuses to.
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    if (isDisclosureAnchorHeld()) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (paneVisibleRef.current && pinnedRef.current) scrollToBottom();
    });
  }, [isDisclosureAnchorHeld, scrollToBottom]);

  // Re-pins before the browser paints. A ResizeObserver callback runs after
  // layout and before paint, so a `requestAnimationFrame` requested from it
  // lands in the *next* frame: the current frame painted the grown content
  // unpinned and the next one snapped it back, which read as the transcript
  // twitching whenever a row changed height after mount (D287). Scrolling from
  // inside the callback costs nothing extra (layout is already clean) and
  // cannot resize the observed box, so it never re-triggers the observer.
  //
  // A manual disclosure holds the title the reader toggled (#324) and is
  // restored first: its height can keep changing for several frames, and
  // re-pinning on any one of them is what dragged that title out of view.
  const followScrollNow = useCallback(() => {
    if (paneVisibleRef.current && restoreHeldDisclosure()) return;
    if (!paneVisibleRef.current || !pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, restoreHeldDisclosure, scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);

  // Follow the stream only while the user is pinned to the bottom; a manual
  // scroll up pauses following and surfaces the jump-to-latest pill.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !paneVisibleRef.current || !transcriptHasLayout(el)) return;
    lastLaidOutScrollTopRef.current = el.scrollTop;
    // A real gesture is never stale noise: the reader's own input took the
    // scroller to the near-top band, and this event is the last one that
    // position produces. Suppressing history continuation here would strand an
    // overflowing transcript at the top until some other scroll event or the
    // minimap control arrived (D269). Only an offset this event did not produce
    // — a collapsed box, or a pinned scroller still about to be restored to the
    // bottom — is read as "not at the top".
    const gesturing = isRecentScrollGesture(
      performance.now(),
      lastScrollGestureAtRef.current,
    );
    if (
      paneVisibleRef.current &&
      isHistoryRevealPosition(el, pinnedRef.current && !gesturing)
    ) {
      reachTop(gesturing);
    }
    if (readingWindow) {
      setPinned(false);
      lastScrollTopRef.current = el.scrollTop;
      setShowJump(true);
      return;
    }
    const wasPinned = pinnedRef.current;
    // Only a real gesture (wheel / trackpad / touch / scrollbar / keyboard,
    // on this scroller) releases follow. When the composer collapses or an
    // indicator row unmounts right after send, the browser clamps scrollTop
    // and emits a scroll event that looks like an upward gesture; without
    // this guard it would cancel follow and leave the transcript stuck above
    // the new turn. The tolerance is slack for the fractions a fractional
    // device pixel ratio leaves behind on programmatic corrections; anything a
    // gesture produced is compared exactly, so a one-pixel scroll still
    // unpins.
    // `gesturing` was read above, before the history-reveal question: a real
    // gesture is what makes a near-top offset the reader's own position.
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned,
      tolerancePx: gesturing ? 0 : TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    if (gesturing && transition.releasedFollow) {
      setPinned(false);
      setShowJump(true);
    } else if (transition.releasedFollow) {
      // Programmatic / layout noise: re-baseline the observed position and
      // keep the follow state unchanged instead of treating it as a user
      // gesture. A pinned transcript re-asserts the bottom; an unpinned one
      // stays unpinned.
      setPinned(wasPinned);
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      setPinned(transition.pinned);
      setShowJump(transition.showJump);
    }
  }, [cancelFollowScroll, reachTop, readingWindow, scheduleFollowScroll]);

  // Send / retry / regenerate always re-pins follow mode so the new prompt and
  // its stream stay in view, even if the user had scrolled up through history.
  // This must run in the layout phase: the send state is committed before the
  // persisted user-message event arrives, and a passive effect allows one
  // frame where a long transcript can remain at its old/top position.
  useLayoutEffect(() => {
    const turnStarted = isRunning && !wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (turnStarted) invalidatePrepend();
    if (!turnStarted || !paneVisible) return;
    releaseDisclosureAnchor();
    cancelFollowScroll();
    setPinned(true);
    setShowJump(false);
    scrollToBottom();
    scheduleFollowScroll();
  }, [
    cancelFollowScroll,
    invalidatePrepend,
    isRunning,
    paneVisible,
    releaseDisclosureAnchor,
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
  const { renderedMessages, renderedCompactions } = useTranscriptProjection(
    messages, compactions,
    !isRunning || readingWindow || firstCommit || paneRevealed || pendingLatestRef.current,
  );
  const entries = useMemo(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      previousEntriesRef.current = [];
    }
    const built = buildTranscriptEntries(renderedMessages, renderedCompactions);
    const entries = reuseTranscriptEntries(previousEntriesRef.current, built.entries);
    previousEntriesRef.current = entries;
    return entries;
  }, [renderedMessages, renderedCompactions, sessionId]);
  // Memoized so a re-render that changed no message (jump pill, loading row,
  // window growth) hands `TranscriptHistory` the same array, letting its
  // comparator bail on identity instead of walking every mounted row.
  const allHistoryEntries = useMemo(() => entries.slice(0, -1), [entries]);
  const tailEntry = entries.at(-1);

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
    !readingWindow && firstCommit && allHistoryEntries.length > TRANSCRIPT_INITIAL_MOUNT;
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
      // An empty first paint must not spend this gate: revalidation can still
      // land a long transcript that needs the bounded expand and re-bottom.
      if (allHistoryEntries.length > 0) firstCommitRef.current = false;
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
  }, [allHistoryEntries.length, hydrationBounded, hydrationTick]);

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
    windowSize: readingWindow ? allHistoryEntries.length : windowSize,
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

  const releaseSearchFollow = useCallback((fresh: boolean) => {
    if (fresh) invalidatePrepend();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    setPinned(false);
    setShowJump(true);
  }, [cancelFollowScroll, invalidatePrepend, releaseDisclosureAnchor, setPinned]);
  const recordSearchPosition = useCallback((top: number) => {
    // While search actively aligns its target, it owns the correction. Once a
    // reading gesture ends that alignment, ordinary prepend anchoring resumes.
    invalidatePrepend();
    recordScrollPosition(top);
  }, [invalidatePrepend, recordScrollPosition]);
  useTranscriptSearchFocus({
    target: searchTarget,
    source: messages.find((message) => message.id === searchTarget?.messageId)?.content ?? "",
    visible: paneVisible,
    scrollRef,
    contentRef,
    contentVersion: historyEntries,
    onNavigate: releaseSearchFollow,
    onPosition: recordSearchPosition,
  });

  // The raw page may lead its deferred DOM by a commit. Only the rendered
  // prefix/window can consume its capture, after search/navigation has priority.
  useLayoutEffect(() => {
    if (paneVisibleRef.current) restoreHeldDisclosure();
    commitPrepend({
      messages, renderedMessages, windowSize,
      historyLength: allHistoryEntries.length,
      mountedCount: historyEntries.length,
    }, pinnedRef.current);
  }, [allHistoryEntries.length, commitPrepend, historyEntries, messages, prependRevision, renderedMessages, restoreHeldDisclosure, windowSize]);

  // Runs in the same layout phase the expansion commits in, before the browser
  // paints it, so mounting the remaining history cannot move the rows the user
  // is already looking at. A user who scrolled up during the bounded frame keeps
  // their position: only a still-pinned transcript is re-bottomed.
  useLayoutEffect(() => {
    if (hydrationBounded || !boundedFirstCommitRef.current) return;
    boundedFirstCommitRef.current = false;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    positionAtFoldedBottom();
  }, [cancelFollowScroll, hydrationBounded, hydrationTick, positionAtFoldedBottom]);

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

  // Both bounded and fully mounted transcripts use the projected entries so
  // every marker has a visible anchor. Embedded steering stays inside its turn
  // process and is therefore omitted, while a standalone leading steering is
  // still a top-level message entry.
  const minimapMessages = useMemo(
    () =>
      transcriptEntryMessages(
        tailEntry ? [...historyEntries, tailEntry] : historyEntries,
      ),
    [historyEntries, tailEntry],
  );
  const hasEarlierHistory = transcriptWindow.hiddenAbove > 0 || hasMoreBefore;
  // Only an unread older page needs tail alignment. `hiddenAbove` is already
  // loaded content withheld by the bounded mount window; it must not make a
  // completed short conversation look like a partial server history tail.
  const alignHistoryTail = !readingWindow && hasMoreBefore;


  const revealEarlierHistory = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isHistoryRevealPosition(el)) {
      reachTop(true);
      return;
    }
    invalidatePrepend();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    setPinned(false);
    setShowJump(true);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [cancelFollowScroll, invalidatePrepend, reachTop, releaseDisclosureAnchor, setPinned]);
  const jumpToLatest = useCallback(() => {
    invalidatePrepend();
    releaseDisclosureAnchor();
    setPinned(true);
    cancelFollowScroll();
    lastScrollGestureAtRef.current = -Infinity;
    pendingLatestRef.current = true;
    requestLatestCommit();
    setShowJump(false);
    positionAtFoldedBottom();
  }, [cancelFollowScroll, invalidatePrepend, positionAtFoldedBottom, releaseDisclosureAnchor, setPinned]);

  // Pin the DOM projection that actually committed, including asynchronous
  // session hydration/revalidation. Raw messages can lead deferred rows by a
  // commit; a queued follow frame against that old DOM is not navigation.
  useLayoutEffect(() => {
    if (renderedMessages === messages && !readingWindow) pendingLatestRef.current = false;
    if (!paneVisible || !pinnedRef.current || readingWindow || isDisclosureAnchorHeld()) return;
    cancelFollowScroll();
    positionAtFoldedBottom();
  }, [cancelFollowScroll, isDisclosureAnchorHeld, latestRevision, messages, paneVisible,
    positionAtFoldedBottom, readingWindow, renderedCompactions, renderedMessages]);

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
          !isHistoryRevealPosition(root, pinnedRef.current)
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
    renderedMessages,
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
    alignHistoryTail,
    hydrationBounded,
    veilCovering,
    veilPhase,
    handleScroll,
    revealEarlierHistory,
    scrollToBottom,
    jumpToLatest,
    disclosureAnchorNotifier,
  };
}
