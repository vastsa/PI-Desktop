import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [store, sidebar, chatSurface, transcript, api, main, styles, skeleton] =
  await Promise.all([
    read("../src/stores/app-store.ts"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/ChatTranscript.tsx"),
    read("../src/lib/api.ts"),
    read("../electron/main/index.ts"),
    loadStyles(),
    read("../src/components/SessionLoadingSkeleton.tsx"),
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
  assert.match(transcript, /el\.scrollTop <= 120/);
  assert.match(chatSurface, /hasMoreBefore=/);
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

test("changed session trees render through a transcript-shaped skeleton", () => {
  assert.match(chatSurface, /useDeferredValue\(activeSessionId\)/);
  assert.doesNotMatch(chatSurface, /previousTranscriptViewRef/);
  assert.match(chatSurface, /aria-busy=\{sessionSwitching\}/);
  assert.match(chatSurface, /session-switch-progress/);
  assert.match(chatSurface, /<SessionLoadingSkeleton \/>/);
  assert.match(skeleton, /data-testid="session-loading-skeleton"/);
  assert.match(styles, /\.session-loading-skeleton[\s\S]*?animation: session-loading-skeleton-in/);
  assert.match(styles, /\.session-loading-skeleton-line[\s\S]*?animation: session-loading-skeleton-pulse 900ms/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.session-loading-skeleton-line[\s\S]*?animation: none[\s\S]*?\.session-switch-progress > span[\s\S]*?animation: none/,
  );
});
