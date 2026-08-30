import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [app, chatSurface, transcript, minimap, composer, styles, store] =
  await Promise.all([
    read("../src/App.tsx"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/components/ConversationMinimap.tsx"),
    read("../src/components/Composer.tsx"),
    loadStyles(),
    read("../src/stores/app-store.ts"),
  ]);

test("streaming state stays inside the chat render boundary", () => {
  assert.match(app, /<ChatSurface \/>/);
  assert.doesNotMatch(app, /useAppStore\(\(s\) => s\.messages\)/);
  assert.doesNotMatch(app, /<ChatTranscript/);
  assert.match(chatSurface, /export const ChatSurface = memo/);
  assert.match(chatSurface, /const messages = useAppStore/);
  assert.match(chatSurface, /const StableComposer = memo\(Composer\)/);
});

test("chat configuration errors still navigate to agent settings", () => {
  assert.match(chatSurface, /store\.setSettingsTab\("agent"\)/);
  assert.match(chatSurface, /store\.setPage\("settings"\)/);
});

test("secondary destinations stay outside the initial shell bundle", () => {
  assert.match(app, /const SettingsPage = lazy/);
  assert.match(app, /import\("\.\/pages\/SettingsPage"\)/);
  assert.match(app, /import\("\.\/pages\/PluginsPage"\)/);
  assert.match(app, /<Suspense fallback=\{<RoutePending \/>\}>/);
});

test("bootstrap cannot replay navigation after destination state changes", () => {
  assert.match(app, /const bootstrapStartedRef = useRef\(false\);/);
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*if \(bootstrapStartedRef\.current\) return;\s*bootstrapStartedRef\.current = true;\s*void bootstrap\(\);\s*\}, \[bootstrap\]\);/,
  );
  const subscriptions =
    app.match(/useEffect\(\(\) => \{\s*const offEvent = api\.onAgentEvent[\s\S]*?\n  \}, \[/)?.[0] ?? "";
  assert.ok(subscriptions);
  assert.doesNotMatch(subscriptions, /bootstrap\(\)/);
});

test("stream rendering avoids duplicate frame state and coalesces following", () => {
  assert.match(transcript, /const displayed = message\.content \|\| "";/);
  assert.doesNotMatch(transcript, /useTypewriter/);
  assert.doesNotMatch(transcript, /setVisibleLen/);
  assert.match(transcript, /const scheduleFollowScroll = useCallback/);
  assert.match(transcript, /followFrameRef\.current !== 0/);
  assert.match(transcript, /const renderedMessages = sessionSwitched \? messages : deferredMessages/);
  assert.match(transcript, /const \{ entries, visible \} = useMemo/);
  assert.match(
    transcript,
    /buildTranscriptEntries\(renderedMessages, renderedCompactions\)/,
  );
  assert.match(transcript, /const TranscriptHistory = memo/);
  assert.match(transcript, /const TranscriptTail = memo/);
  assert.match(transcript, /function transcriptEntryEqual/);
  // Memoized on `entries`: a re-render that changed no message must hand
  // `TranscriptHistory` the same array so its comparator bails on identity
  // instead of deep-walking every mounted row (D261).
  assert.match(
    transcript,
    /const allHistoryEntries = useMemo\(\(\) => entries\.slice\(0, -1\), \[entries\]\)/,
  );
  assert.match(transcript, /<TranscriptHistory entries=\{historyEntries\}/);
  assert.match(transcript, /<TranscriptTail[\s\S]*?entry=\{tailEntry\}/);
  assert.match(transcript, /activityGroupPropsEqual/);
  assert.match(transcript, /assistantTurnPropsEqual/);
});

test("stream event bursts are coalesced until a paint or terminal event", () => {
  assert.match(store, /createFrameBatcher<AgentEventEnvelope>/);
  assert.match(store, /streamUpdates\.enqueue\(/);
  assert.match(store, /streamUpdates\.flushNow\(\)/);
  assert.match(store, /event\.type === "message_update"/);
  assert.match(store, /event\.type === "tool_update"/);
});

test("tool errors stay local to their rows instead of failing the activity group", () => {
  assert.doesNotMatch(transcript, /const hasFailure = items\.some/);
  assert.doesNotMatch(transcript, /processingFailedAfter/);
  assert.doesNotMatch(transcript, /tool-activity-group[\s\S]*?failed/);
  // A failure opens its own row and nothing else. The row reads the failure
  // from the command's exit code as well as the call's status (D227), so the
  // auto-open hangs off that derived flag.
  assert.match(transcript, /const failed = status === "error" \|\| run === "failed"/);
  assert.match(transcript, /const \[open, setOpen\] = useState\(failed\)/);
  assert.match(transcript, /if \(failed\) setOpen\(true\)/);
  assert.match(transcript, /status === "error"\s*\? t\("chat\.toolFailed"\)/);
});

test("manual upward scrolling cancels pending transcript follow work", () => {
  assert.match(transcript, /reduceTranscriptScroll/);
  assert.match(
    transcript,
    /if \(transition\.releasedFollow\) cancelFollowScroll\(\)/,
  );
  assert.match(transcript, /pinnedRef\.current = transition\.pinned/);
  assert.match(transcript, /setShowJump\(transition\.showJump\)/);
});

test("send re-pins before paint instead of flashing the old transcript position", () => {
  const turnStartEffect = transcript.match(
    /\/\/ Send \/ retry \/ regenerate[\s\S]*?useLayoutEffect\(\(\) => \{([\s\S]*?)\n  \}, \[[\s\S]*?\]\);/,
  )?.[1] ?? "";
  assert.match(turnStartEffect, /const turnStarted = isRunning && !wasRunningRef\.current/);
  assert.match(turnStartEffect, /cancelFollowScroll\(\)/);
  assert.match(turnStartEffect, /pinnedRef\.current = true/);
  assert.match(turnStartEffect, /scrollToBottom\(\)/);
  assert.match(transcript, /const targetTop = Math\.max\(0, el\.scrollHeight - el\.clientHeight\)/);
});

test("layout clamps after send cannot release transcript follow as a gesture", () => {
  assert.match(transcript, /const lastScrollGestureAtRef = useRef\(-Infinity\)/);
  assert.match(transcript, /markScrollGesture = useCallback/);
  assert.match(
    transcript,
    /event\.type === "wheel" \|\|\s*event\.type === "touchstart" \|\|\s*event\.type === "touchmove"/,
  );
  assert.match(transcript, /event\.type === "pointerdown"/);
  assert.match(transcript, /el\.addEventListener\("wheel", markScrollGesture/);
  assert.match(transcript, /className="thread-wrap" ref=\{wrapRef\}/);
  assert.match(
    transcript,
    /const released =\s*transition\.releasedFollow &&\s*isRecentScrollGesture\(/,
  );
  assert.match(
    transcript,
    /isRecentScrollGesture\(\s*performance\.now\(\),\s*lastScrollGestureAtRef\.current,\s*\)/,
  );
  assert.match(transcript, /if \(transition\.releasedFollow\) cancelFollowScroll\(\)/);
});

test("session activation pins the latest record before the first paint", () => {
  assert.match(
    chatSurface,
    /const activeSessionId = useAppStore\(\(state\) => state\.activeSessionId\);/,
  );
  assert.match(
    chatSurface,
    /<ChatTranscript[\s\S]*?sessionId=\{transcriptView\.sessionId\}/,
  );
  assert.match(chatSurface, /useDeferredValue\(activeSessionId\)/);
  assert.match(chatSurface, /previousTranscriptViewRef/);
  assert.doesNotMatch(chatSurface, /SessionLoadingSkeleton/);

  const activationEffect = transcript.match(
    /useLayoutEffect\(\(\) => \{([\s\S]*?)\n  \}, \[cancelFollowScroll, sessionId, scrollToBottom\]\);/,
  )?.[1];
  assert.ok(activationEffect);
  assert.match(activationEffect, /cancelFollowScroll\(\)/);
  assert.match(activationEffect, /pinnedRef\.current = true/);
  assert.match(activationEffect, /setShowJump\(false\)/);
  assert.match(activationEffect, /scrollToBottom\(\)/);
  assert.doesNotMatch(activationEffect, /smooth/);
});

test("session switch bounds the first transcript commit instead of rebuilding it", () => {
  // Progressive hydration must decide during render. Setting the gate from a
  // layout effect (`useState(true)` + `setHydrated(false)`) meant a switch
  // mounted the whole history, threw it away, and rebuilt it - three commits,
  // and the long sessions this protects paid for the full DOM anyway.
  const hydration = transcript.slice(
    transcript.indexOf("// Progressive hydration"),
    transcript.indexOf("const lastEntry = entries[entries.length - 1];"),
  );
  assert.ok(hydration.length > 0, "hydration block must exist");
  assert.match(
    hydration,
    /const hydrationBounded =\s*hydratedSessionRef\.current !== sessionId &&/,
    "the gate must be derived from the rendered session, not stored state",
  );
  // The first commit is bounded by the initial mount budget, and the expansion
  // target is the steady-state window rather than the whole history (D261).
  assert.match(
    hydration,
    /allHistoryEntries\.length > TRANSCRIPT_INITIAL_MOUNT/,
  );
  assert.match(
    hydration,
    /const transcriptWindow = reduceTranscriptWindow\(\{[\s\S]*?initialCommit: hydrationBounded,/,
  );
  assert.match(
    hydration,
    /transcriptWindow\.bounded\s*\?\s*allHistoryEntries\.slice\(-transcriptWindow\.mounted\)/,
  );
  // No layout effect may flip the gate; that is what caused the extra commits.
  // (A layout effect that only re-anchors scrolling after the expansion is fine;
  // what must not come back is a layout effect deciding what to mount.)
  const hydrationGate = hydration.slice(
    0,
    hydration.indexOf("const historyEntries ="),
  );
  assert.doesNotMatch(hydrationGate, /useLayoutEffect/);
  assert.doesNotMatch(transcript, /setHydrated\(/);
  // The spacer only makes the bounded bottom reachable.
  assert.match(
    transcript,
    /\{hydrationBounded \? \([\s\S]*?transcript-hydration-spacer/,
  );
});

test("session-switch hydration expands without moving the transcript", () => {
  // A spacer sized per unmounted entry cannot match the rows it stands in for.
  // Mounting the real history then corrected that guess on screen, which is the
  // transcript jumping up and down like a page flip on every session switch.
  assert.doesNotMatch(
    transcript,
    /TRANSCRIPT_INITIAL_MOUNT\) \* \d+/,
    "the hydration spacer must not derive its height from a per-entry estimate",
  );
  assert.doesNotMatch(
    transcript,
    /transcript-hydration-spacer[\s\S]{0,200}?minHeight/,
    "spacer height belongs to CSS, not to an inline per-entry computation",
  );

  // Re-pinning must happen in the layout phase of the expansion commit, before
  // paint - a passive effect leaves one visible frame at the wrong offset.
  const rebottom = transcript.match(
    /useLayoutEffect\(\(\) => \{\n\s*if \(hydrationBounded \|\| boundedSessionRef\.current !== sessionId\) return;([\s\S]*?)\n  \}, \[/,
  )?.[1];
  assert.ok(rebottom, "the hydration expansion must re-anchor in a layout effect");
  assert.match(rebottom, /boundedSessionRef\.current = null/);
  assert.match(rebottom, /scrollToBottom\(\)/);
  // A user who scrolled up during the bounded frame keeps their position.
  assert.match(rebottom, /if \(!pinnedRef\.current\) return/);

  // The pending-re-anchor flag must not be written during render: StrictMode
  // double-renders and abandoned concurrent renders would set it for a commit
  // that never happens, re-bottoming a transcript the user had scrolled up in.
  assert.doesNotMatch(
    transcript,
    /if \(hydrationBounded\) boundedSessionRef\.current/,
    "the pending re-anchor must be recorded from an effect, not during render",
  );
  assert.match(
    transcript,
    /boundedSessionRef\.current = sessionId;\n\s*const frame = requestAnimationFrame/,
    "the flag is armed in the same effect that queues the expansion",
  );
});

test("minimap separates resize checks from message-position measurement", () => {
  assert.match(minimap, /buildConversationMinimapMarkers\(messages\)/);
  assert.match(minimap, /const markerIdentity = useMemo/);
  assert.match(minimap, /new ResizeObserver\(scheduleResize\)/);
  assert.match(minimap, /resizeRaf = requestAnimationFrame\(\(\) => \{/);
  assert.match(minimap, /recomputeOffsets\(\);[\s\S]*?updateOverflow\(\);/);
  assert.match(minimap, /addEventListener\("scroll", scheduleScroll/);
  assert.match(minimap, /behavior: reduceMotion \? "auto" : "smooth"/);
});

test("minimap hover magnification never measures geometry per dash", () => {
  // applyMagnify runs on every mousemove frame. Reading a dash's offsetTop in
  // the same loop that writes --magnify forces a synchronous layout per dash, so
  // hovering a long conversation's rail cost O(markers) layouts a frame. Centers
  // are measured once per layout instead, and the hover loop only writes.
  const applyMagnify = minimap.slice(
    minimap.indexOf("const applyMagnify"),
    minimap.indexOf("const handleMouseMove"),
  );
  const loopStart = applyMagnify.indexOf("for (const { id, center }");
  assert.ok(loopStart > 0, "applyMagnify must iterate the cached centers");
  const loopBody = applyMagnify.slice(loopStart, applyMagnify.indexOf("\n    }\n", loopStart));
  assert.doesNotMatch(
    loopBody,
    /\.(offsetTop|offsetHeight|clientHeight|clientWidth|getBoundingClientRect|scrollTop|scrollHeight)\b/,
    "the per-dash loop must not read layout geometry",
  );
  assert.match(loopBody, /style\.setProperty\("--magnify"/);

  // The measurement pass is read-only, so it cannot thrash either.
  const measure = minimap.slice(
    minimap.indexOf("const measureMagnifyCenters"),
    minimap.indexOf("/* Fresh offset query"),
  );
  assert.match(measure, /btn\.offsetTop \+ btn\.offsetHeight \/ 2/);
  assert.doesNotMatch(measure, /style\.setProperty/);

  // Centers move when the marker set changes and when the rail is resized (its
  // gap is marker-count dependent and its height follows the composer).
  assert.match(
    minimap,
    /\}, \[markerIdentity, measureMagnifyCenters, recomputeOffsets, updateOverflow\]\)/,
  );
  const resize = minimap.slice(
    minimap.indexOf("const scheduleResize"),
    minimap.indexOf("// Initial offset computation"),
  );
  assert.match(resize, /measureMagnifyCenters\(\)/);
});

test("minimap re-measures dash centers when the rail's own box changes", () => {
  // The rail's height is `calc(var(--composer-dock-height) + 16px)` and the
  // composer republishes that variable on documentElement as its draft grows.
  // That moves every dash without changing the marker set and without a window
  // resize, so observing only the thread content left magnification tracking
  // stale positions while the user typed a multi-line prompt.
  assert.match(minimap, /new ResizeObserver\(\(\) => \{[\s\S]*?measureMagnifyCenters\)/);
  const railObserver = minimap.slice(
    minimap.indexOf("const rail = railRef.current;\n    if (!rail || typeof ResizeObserver"),
    minimap.indexOf("const jumpTo = useCallback("),
  );
  assert.ok(railObserver.length > 0, "the rail must be observed for its own resizes");
  assert.match(railObserver, /observer\.observe\(rail\)/);
  assert.match(railObserver, /observer\.disconnect\(\)/);
  assert.match(railObserver, /cancelAnimationFrame\(frame\)/);
  // `overflows` gates whether the rail is mounted, so the observer must reattach.
  assert.match(railObserver, /\}, \[measureMagnifyCenters, overflows\]\)/);
  // The composer is the source of that variable.
  assert.match(
    composer,
    /setProperty\(\s*"--composer-dock-height"/,
  );
});

test("motion feedback is composited, bounded, and accessible", () => {
  assert.match(styles, /@keyframes route-surface-in/);
  assert.match(styles, /@keyframes work-panel-in/);
  assert.match(styles, /@keyframes work-panel-out/);
  assert.match(styles, /@keyframes work-panel-out-windows/);
  assert.match(
    styles,
    /:root\[data-platform="win32"\] \.work-panel\.is-exiting \{[^}]*animation-name:\s*work-panel-out-windows;/s,
  );
  assert.match(styles, /translateX\(8px\)/);
  assert.match(styles, /\.composer-shell:focus-within/);
  assert.doesNotMatch(styles, /backdrop-filter:\s*blur/);
  assert.match(styles, /\.chat-error-notice > span[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.route-surface,[\s\S]*?animation-duration:\s*0\.01ms !important/,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.work-panel\.is-exiting[\s\S]*?animation-duration:\s*0\.01ms !important/,
  );
});
