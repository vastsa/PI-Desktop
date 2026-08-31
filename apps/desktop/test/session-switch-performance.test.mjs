import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, sidebar, chatSurface, pane, panes, transcript, api, main, styles] =
  await Promise.all([
    read("../src/stores/app-store.ts"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/SessionPane.tsx"),
    read("../src/lib/session-panes.ts"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/lib/api.ts"),
    read("../electron/main/index.ts"),
    loadStyles(),
  ]);

test("session reads use a bounded tail and load older pages on demand", () => {
  assert.match(store, /SESSION_TRANSCRIPT_PAGE_SIZE = 100/);
  assert.match(store, /SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 \* 1024/);
  assert.match(store, /loadOlderMessages: async/);
  assert.match(store, /messageBefore: before/);
  assert.match(api, /messageLimit\?: number/);
  assert.match(api, /contentLimit\?: number/);
  assert.match(main, /messageBefore\?: number/);
  assert.match(
    main,
    /host\.call<\{ session\?: RuntimeSession \| null \}>\("session\.get"/,
  );
  assert.match(transcript, /onLoadOlder\?: \(\) => Promise<void>/);
  // The near-top band is one named constant shared by the scroll check and the
  // D269 boundary observer, so the two triggers cannot drift apart.
  assert.match(transcript, /HISTORY_REVEAL_THRESHOLD_PX = 120/);
  assert.match(
    transcript,
    /el\.scrollTop <= HISTORY_REVEAL_THRESHOLD_PX/,
  );
  // Paging is wired per retained pane (ADR 0136), so each pane requests its own
  // older pages rather than the surface requesting them for whichever session
  // happens to be active.
  assert.match(pane, /hasMoreBefore=\{hasMoreBefore\}/);
  assert.match(pane, /onLoadOlder=\{\(\) => loadOlderMessages\(sessionId\)\}/);
});

test("session reads are coalesced, bounded, and never globally serialized", () => {
  assert.match(store, /const SESSION_TRANSCRIPT_CACHE_LIMIT = 20/);
  assert.match(store, /const sessionDetailLoads = new Map/);
  assert.match(store, /const active = sessionDetailLoads\.get\(id\)/);
  assert.match(store, /const detailPromise = loadSessionDetail\(id, \{/);
  assert.doesNotMatch(store, /sessionSelectionQueue/);
});

test("only the latest navigation may commit a loaded transcript", () => {
  const selection = store.match(
    /selectSession: async[\s\S]*?\n  newSession: async/,
  )?.[0] ?? "";
  assert.match(selection, /set\(\{ selectingSessionId: id, page: "chat" \}\)/);
  assert.match(selection, /navigationIntentIsCurrent\(intent\)/);
  assert.match(
    selection,
    /commitSelection\(detail\.session\?\.messages \?\? \[\], false, historyWindow\)/,
  );
  assert.ok(
    selection.indexOf("const detailPromise = loadSessionDetail(id)") <
      selection.indexOf("await alignWorkspaceLatest(summary.projectPath)"),
  );
  // A warm switch must be revealed before any await, otherwise a session that is
  // already fully painted still waits for workspace alignment to show up.
  assert.match(
    selection,
    /commitSelection\(get\(\)\.retainedTranscripts\[id\], true\)/,
  );
  assert.ok(
    selection.indexOf("get().retainedTranscripts[id]") <
      selection.indexOf("await alignWorkspaceLatest(summary.projectPath)"),
    "the retained pane must be revealed before workspace alignment is awaited",
  );
});

test("sidebar owns feedback and prefetch while store owns workspace alignment", () => {
  assert.match(sidebar, /const selectedSessionId = selectingSessionId \?\? activeSessionId/);
  assert.match(sidebar, /onPointerEnter=\{\(\) => scheduleSessionPrefetch\(session\.id\)\}/);
  assert.match(sidebar, /onFocus=\{\(\) => void prefetchSession\(session\.id\)/);
  const projectSelection = sidebar.match(
    /const selectProjectSession[\s\S]*?\n  const selectTemporarySession/,
  )?.[0] ?? "";
  assert.match(projectSelection, /await selectSession\(session\.id\)/);
  assert.doesNotMatch(projectSelection, /await selectProject\(|activateProject\(/);
});

test("each retained session keeps its own mounted pane", () => {
  // One pane per retained session, keyed by session id, so a switch reveals an
  // already-painted pane instead of re-pointing one transcript (ADR 0136).
  assert.match(
    chatSurface,
    /retainedSessionIds\.map\(\(id\) => \(\s*<SessionPane\s*key=\{id\}\s*sessionId=\{id\}\s*visible=\{id === visibleSessionId\}/,
  );
  assert.match(chatSurface, /const visibleSessionId = retainedSessionIds\[0\]/);
  // The retention bound lives in a pure module, so eviction is unit-testable
  // (see session-panes.test.mjs) and other store paths can release a pane
  // without reaching into the component tree.
  assert.match(panes, /export const RETAINED_SESSION_PANE_LIMIT = 3/);
  assert.match(panes, /\.slice\(0, RETAINED_SESSION_PANE_LIMIT\)/);
  assert.match(panes, /export function retainSessionPane\(/);
  assert.match(panes, /export function releaseSessionPane\(/);
  assert.match(store, /\.\.\.retainSessionPane\(s, id, messages\)/);
  // A pane reads the live projection only while it owns the active session.
  assert.match(
    pane,
    /const messages = isActiveProjection \? liveMessages : snapshot \?\? \[\]/,
  );
  assert.doesNotMatch(chatSurface, /SessionLoadingSkeleton/);
  assert.doesNotMatch(styles, /session-loading-skeleton/);
});

test("hidden panes keep their layout box and stay inert", () => {
  // `display: none` would drop the layout box and reset every scroller inside
  // the pane, which is exactly the retention this relies on.
  const hidden =
    styles.match(/\.session-pane\[data-visible="false"\]\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(hidden, /position:\s*absolute/);
  assert.match(hidden, /visibility:\s*hidden/);
  assert.match(hidden, /content-visibility:\s*hidden/);
  assert.match(hidden, /pointer-events:\s*none/);
  assert.doesNotMatch(hidden, /display:\s*none/);
  assert.match(pane, /aria-hidden=\{visible \? undefined : true\}/);
  assert.match(pane, /inert=\{visible \? undefined : true\}/);
  // A hidden pane must not chase its stream; it re-anchors when revealed.
  assert.match(transcript, /if \(!paneVisibleRef\.current\) return;/);
});

test("a hidden pane does no reading work off screen", () => {
  // An unrendered scroller reports `scrollTop === 0`, which reads as "at the
  // top": without these gates a background session would page its own history
  // and measure row positions against a subtree the engine is not laying out.
  assert.match(transcript, /if \(!paneVisible\) return;\n\s*let frame = 0;/);
  assert.match(
    transcript,
    /const loadOlder = useCallback\(\(\) => \{[\s\S]*?if \(!paneVisibleRef\.current\) return;/,
  );
  assert.match(transcript, /\{paneVisible \? \(\s*<ConversationMinimap/);
});

test("a cold switch keeps the visible pane legible instead of dimming it", () => {
  assert.match(chatSurface, /aria-busy=\{sessionSwitching\}/);
  assert.match(chatSurface, /session-switch-progress/);
  assert.match(
    chatSurface,
    /Boolean\(selectingSessionId\) && selectingSessionId !== visibleSessionId/,
  );
  // Only the composer goes inert, so a prompt cannot reach the session being
  // left. The transcript keeps full contrast: the dim was itself a visible flash.
  assert.match(
    styles,
    /\.chat-surface\.session-switching > \.composer-dock\s*\{\s*pointer-events: none;\s*\}/,
  );
  assert.doesNotMatch(styles, /session-switching[\s\S]{0,200}?opacity: 0\.82/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.session-switch-progress > span[\s\S]*?animation: none/,
  );
});
