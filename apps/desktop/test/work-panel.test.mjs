import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../src/lib/work-panel-resize.ts";

const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const panelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = await readFile(
  new URL("../src/components/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("work panel replaces the context panel overlay", async () => {
  await assert.rejects(
    access(new URL("../src/components/ContextPanel.tsx", import.meta.url)),
    { code: "ENOENT" },
  );
  assert.doesNotMatch(appSource, /ContextPanel/);
  assert.doesNotMatch(appSource, /contextOpen/);
  assert.match(appSource, /case "openWorkPanel"/);
  assert.match(appSource, /useAppStore\.getState\(\)\.toggleWorkPanel\(\)/);
  assert.match(storeSource, /openWorkPanel:\s*\(\) => \{/);
  // The panel is toggled inside the renderer store; the legacy main-process
  // nav bridge that resized the OS window must stay gone.
  assert.doesNotMatch(appSource, /nav\.toggleWorkPanel/);
  assert.doesNotMatch(appSource, /key\.toLowerCase\(\) === "j"/);
});

test("the work panel shortcut closes the panel it opened", () => {
  assert.match(storeSource, /toggleWorkPanel:\s*\(\) => \{/);
  const toggleBody = storeSource.slice(
    storeSource.indexOf("toggleWorkPanel: () => {"),
    storeSource.indexOf("openWorkPanelTabForSession: (sessionId, tab) => {"),
  );
  assert.match(toggleBody, /get\(\)\.workPanelOpen/);
  assert.match(toggleBody, /collapseWorkPanel\(\)/);
  assert.match(toggleBody, /openWorkPanel\(\)/);
});

test("work panel uses the fixed-window internal dock", () => {
  assert.match(appSource, /presentedWorkPanelOpen/);
  assert.match(appSource, /setPresentedWorkPanelOpen/);
  assert.match(appSource, /workPanelExiting/);
  // The renderer keeps the reservation seam at zero: opening and collapsing
  // only change the in-flow flex allocation inside the existing window.
  assert.match(appSource, /setWorkPanelReservation\(0\)/);
  assert.doesNotMatch(appSource, /requestedWidth\s*=\s*Math\.round\(workPanelWidth\)/);
  assert.match(mainSource, /requestedWorkPanelReservation = 0/);
  assert.match(mainSource, /return \{ requested: 0, reserved: 0 \}/);
  assert.match(appSource, /commitWorkPanelPresentation/);
  assert.doesNotMatch(appSource, /\.finally\(\(\) => \{[\s\S]*setPresentedWorkPanelOpen/);
  // Mount follows presentation commit; exit keep-alive plays work-panel-out
  // before unmounting, so MainChat reflows continuously in both directions.
  assert.match(
    appSource,
    /<\/section>\s*\{\(presentedWorkPanelOpen \|\| workPanelExiting\) && \(?\s*<WorkPanel/,
  );
  assert.doesNotMatch(
    appSource,
    /<\/section>\s*\{workPanelOpen && \(?\s*<WorkPanel/,
  );
  assert.match(appSource, /finishWorkPanelExit/);
  assert.match(appSource, /onExitAnimationEnd=\{\(\) =>/);
  assert.match(appSource, /finishWorkPanelExit\(workPanelExitGeneration\.current\)/);
  assert.match(panelSource, /browserSetVisible\(false\)/);
  assert.match(panelSource, /nativeSurfaceReadyForExit/);
  assert.match(panelSource, /is-exit-pending/);
  assert.match(panelSource, /exitAnimationReady && "is-exiting"/);
  assert.match(panelSource, /if \(!exitAnimationReady\) return/);
  assert.match(panelSource, /animationName\.startsWith\("work-panel-out"\)/);
  assert.match(panelSource, /renderPanelWidth = clampWorkPanelWidth\(panelDragWidth \?\? width\)/);
  assert.match(panelSource, /setWidth\(drag\.currentWidth\)/);
  // The panel remains a fixed-width in-flow shell sibling; its flex allocation
  // is animated with the dock so the main pane does not jump before motion.
  assert.match(globalStyles, /\.work-panel \{[^}]*flex: 0 0 var\(--work-panel-width\)/s);
  assert.match(panelSource, /"--work-panel-width": `\$\{renderPanelWidth\}px`/);
  assert.doesNotMatch(
    globalStyles.match(/\.work-panel \{[^}]*\}/s)?.[0] ?? "",
    /position:\s*absolute/,
  );
  assert.match(globalStyles, /@keyframes work-panel-out/);
  assert.doesNotMatch(globalStyles, /@keyframes work-panel-out-windows/);
  assert.match(
    globalStyles,
    /@keyframes work-panel-in \{[^}]*flex-basis:\s*0;[^}]*width:\s*0;[^}]*translateX\(8px\)/s,
  );
  assert.match(
    globalStyles,
    /@keyframes work-panel-out \{[\s\S]*?flex-basis:\s*0;[\s\S]*?width:\s*0;/,
  );
});

test("work panel header exposes one unified menu with no duplicated entries", () => {
  const headerIndex = panelSource.indexOf('className="work-panel-header"');
  const contextIndex = panelSource.indexOf('className="work-panel-context no-drag"');
  const actionsIndex = panelSource.indexOf('className="work-panel-actions no-drag"');
  const bodyIndex = panelSource.indexOf('<div className="work-panel-body">');

  assert.ok(contextIndex > headerIndex);
  assert.ok(actionsIndex > contextIndex && bodyIndex > actionsIndex);
  assert.match(panelSource, /HEADER_TOOLS\.map\(\(\{ kind, Icon \}, index\)/);
  assert.match(panelSource, /aria-expanded=\{contextOpen\}/);
  assert.match(panelSource, /aria-controls="work-panel-context-menu"/);
  assert.match(panelSource, /data-action=\{`open-work-panel-\$\{kind\}`\}/);
  assert.match(panelSource, /function headerToolTab\(kind: HeaderToolKind\): WorkPanelTab/);
  // Browsing the project is the bundled `pi.files` plugin now, so the host's
  // tool list no longer carries a Files entry. The `file` *kind* remains: a
  // `file:<path>` tab is a transcript artifact, not a launcher entry.
  assert.doesNotMatch(panelSource, /\{ kind: "file", Icon/);
  assert.match(panelSource, /openWorkPanelTab\(headerToolTab\(kind\)\)/);
  assert.match(panelSource, /className="work-panel-context-menu"/);
  assert.match(panelSource, /id=\{activeTab \? `work-panel-title-\$\{activeTab\.id\}`/);
  assert.match(panelSource, /role="menuitemradio"/);
  assert.match(panelSource, /aria-checked=\{selected\}/);
  assert.match(panelSource, /data-work-panel-switch-item/);
  assert.match(panelSource, /data-work-panel-menu-item/);
  assert.match(panelSource, /role="tabpanel"/);
  assert.match(panelSource, /className="work-panel-current-close"/);
  assert.match(panelSource, /className="work-panel-menu-close"/);
  // The tools section lists each singleton once with its own close control, so
  // the second section may only carry transcript-opened resources. Plugin views
  // are tools too, so the predicate lives in work-panel-tabs alongside them.
  assert.match(
    panelSource,
    /const resourceTabs = tabs\.filter\(\(tab\) => !isToolWorkPanelTab\(tab\)\)/,
  );
  assert.match(panelSource, /\{resourceTabs\.length > 0 && \(/);
  assert.match(panelSource, /resourceTabs\.map\(\(tab, index\) =>/);
  assert.doesNotMatch(panelSource, /tabs\.map\(\(tab, index\) =>/);
  // Reopening an already-open tool must reuse its tab so the browser keeps its
  // resource instead of being replaced by a blank singleton.
  assert.match(panelSource, /const existing = tabs\.find\(\(tab\) => tab\.id === kind\)/);
  assert.match(panelSource, /if \(existing\) activateTab\(existing\.id\)/);
  assert.doesNotMatch(panelSource, /collapsePanel/);
  assert.doesNotMatch(panelSource, /work-panel-collapse/);
  assert.match(panelSource, /onCollapse/);
  assert.match(panelSource, /work-panel-toolbar-collapse/);
  assert.match(panelSource, /data-work-panel-section="current"/);
  assert.match(panelSource, /panel\.tools/);
  assert.match(panelSource, /panel\.openItems/);
  assert.match(panelSource, /panel\.tabs\.file/);
  assert.match(panelSource, /panel\.pluginViews/);
  assert.doesNotMatch(panelSource, /panel\.openTool/);
  // Every native surface in the panel — the preview browser and each plugin
  // view — composites above the renderer, so one blocking condition governs
  // them all.
  assert.match(
    panelSource,
    /blocked=\{[\s\S]*exiting \|\| panelBlocked \|\| contextOpen \|\| isResizing[\s\S]*\}/,
  );
  assert.doesNotMatch(panelSource, /onContextMenu|createPortal|work-panel-tools-menu/);
  assert.match(
    globalStyles,
    /\.work-panel-context-menu \{[^}]*position:\s*absolute;[^}]*min-width:/s,
  );
  assert.match(
    globalStyles,
    /\.work-panel-context-menu \{[^}]*position:\s*absolute;[^}]*max-height:/s,
  );
  // Header actions are pinned right so they never shift with the label length.
  assert.match(globalStyles, /\.work-panel-actions \{[^}]*margin-left:\s*auto;/s);
  assert.doesNotMatch(globalStyles, /\.work-panel-tabs\s*\{/);
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-create-item|\.work-panel-switcher-(?:row|item|close|list|title)/,
  );
});

test("work panel menu keeps focus, layout, and motion stable while it is open", () => {
  // Arrow keys walk rows only; close buttons stay reachable by pointer and by
  // Delete/Backspace on the focused row.
  assert.match(panelSource, /"\[data-work-panel-menu-item\]"/);
  assert.match(panelSource, /const contextOpenFocus = useRef<"active" \| "last">/);
  assert.match(panelSource, /event\.key === "ArrowUp" \? "last" : "active"/);
  assert.match(
    panelSource,
    /item\.getAttribute\("aria-checked"\) === "true"/,
  );
  assert.match(panelSource, /\(checked \?\? items\[0\]\)\?\.focus\(\)/);
  assert.match(
    panelSource,
    /if \(event\.key === "Delete" \|\| event\.key === "Backspace"\)/,
  );
  assert.match(panelSource, /items\[current\]\?\.dataset\.workPanelCloseId/);
  // Closing a row keeps the menu open and focus on a neighbouring row.
  assert.match(panelSource, /const closeTabFromMenu = useCallback\(/);
  assert.match(panelSource, /items\[Math\.min\(index, items\.length - 1\)\]\?\.focus\(\)/);
  // Dismissal on a context switch only — selecting a row closes it explicitly.
  assert.match(panelSource, /setContextOpen\(false\);\n  \}, \[activeSessionId\]\)/);
  assert.match(panelSource, /const closeContext = useCallback\(/);
  assert.match(panelSource, /contextButtonRef\.current\?\.focus\(\)/);
  // Trailing close slot is always reserved so labels never shift between rows.
  assert.match(globalStyles, /\.work-panel-menu-slot \{[^}]*width:\s*26px;/s);
  assert.match(globalStyles, /\.work-panel-menu-item:focus-visible \{[^}]*outline:/s);
  // Only the label absorbs slack; an element selector here stretched the open
  // dot into a bar, so the label must be targeted by class.
  assert.match(panelSource, /className="work-panel-menu-label"/);
  assert.match(globalStyles, /\.work-panel-menu-label \{[^}]*flex:\s*1 1 auto;/s);
  assert.doesNotMatch(globalStyles, /\.work-panel-menu-item span\s*\{/);
  assert.match(globalStyles, /\.work-panel-open-dot \{[^}]*width:\s*4px;[^}]*flex:\s*0 0 auto;/s);
  // Active row: neutral fill plus a straight 2px edge marker, never color alone.
  assert.match(
    globalStyles,
    /\.work-panel-menu-row\.active::before \{[^}]*width:\s*2px;[^}]*background:\s*var\(--ds-text-primary\)/s,
  );
  assert.match(globalStyles, /@keyframes work-panel-menu-in/);
  assert.match(
    globalStyles,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.work-panel-context-menu \{\s*animation:\s*none;/,
  );
});

test("work panel starts closed with no tabs and persists width only", () => {
  assert.match(storeSource, /workPanelOpen:\s*false/);
  assert.match(storeSource, /workPanelTabs:\s*\[\]/);
  assert.match(storeSource, /activeWorkPanelTabId:\s*null/);
  assert.match(storeSource, /JSON\.stringify\(\{ width \}\)/);
  assert.match(storeSource, /const committedWidth = Math\.round\(width\)/);
  const persistenceBlock =
    storeSource.match(/function saveWorkPanelWidth[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(persistenceBlock, /workPanelContexts|tabs|open/);
});

test("work panel width is renderer-owned inside the fixed window", () => {
  assert.equal(MAIN_PANE_MIN_WIDTH, 360);
  assert.equal(WORK_PANEL_MIN_WIDTH, 244);
  assert.equal(WORK_PANEL_MAX_WIDTH, 720);
  assert.match(panelSource, /renderPanelWidth = clampWorkPanelWidth\(panelDragWidth \?\? width\)/);
  assert.match(panelSource, /setWidth\(drag\.currentWidth\)/);
  assert.match(panelSource, /startWidth \+ drag\.startClientX - event\.clientX/);
  assert.doesNotMatch(panelSource, /api\.setWorkPanelChatWidth/);
  assert.doesNotMatch(panelSource, /api\.onWorkPanelResize/);
  assert.doesNotMatch(panelSource, /\.sidebar, \.sidebar-rail/);
  assert.match(globalStyles, /\.main-pane \{[^}]*min-width:\s*0;/s);
  assert.match(globalStyles, /\.work-panel \{[^}]*flex: 0 0 var\(--work-panel-width\)/s);
  // The Electron seam remains available for old callers but is deliberately
  // inert, so no positive target can expand the native window.
  const reservationHandler = mainSource.slice(
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelReservation"),
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelChatWidth"),
  );
  assert.match(reservationHandler, /requestedWorkPanelReservation = 0/);
  assert.match(reservationHandler, /return \{ requested: 0, reserved: 0 \}/);
  assert.doesNotMatch(reservationHandler, /applyWorkPanelReservation/);
});

test("work panel keeps its compatibility IPC seams without native geometry", () => {
  assert.match(
    protocolSource,
    /windowSetWorkPanelReservation:\s*"pi-desktop\/window\/setWorkPanelReservation"/,
  );
  assert.match(
    apiSource,
    /setWorkPanelReservation:\s*\(width: number\)[\s\S]*IPC\.invoke\.windowSetWorkPanelReservation/,
  );
  assert.match(mainSource, /IPC\.invoke\.windowSetWorkPanelReservation/);
  assert.match(mainSource, /parseWorkPanelReservationWidth/);
  assert.match(mainSource, /return \{ requested: 0, reserved: 0 \}/);
  assert.match(
    protocolSource,
    /windowSetWorkPanelChatWidth:\s*"pi-desktop\/window\/setWorkPanelChatWidth"/,
  );
  assert.match(
    protocolSource,
    /windowWorkPanelResize:\s*"pi-desktop\/window\/event\/workPanelResize"/,
  );
  assert.match(apiSource, /setWorkPanelChatWidth/);
  assert.match(apiSource, /onWorkPanelResize/);
  assert.match(mainSource, /IPC\.invoke\.windowSetWorkPanelChatWidth/);
  assert.match(mainSource, /IPC\.event\.windowWorkPanelResize/);
});

test("native window edges never own the internal panel width", () => {
  assert.doesNotMatch(panelSource, /onWorkPanelResize/);
  assert.doesNotMatch(panelSource, /setWorkPanelChatWidth/);
  assert.match(panelSource, /setWidth\(drag\.currentWidth\)/);
  assert.match(mainSource, /resizable:\s*true/);
  const reservationHandler = mainSource.slice(
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelReservation"),
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelChatWidth"),
  );
  assert.doesNotMatch(reservationHandler, /applyWorkPanelReservation/);
  assert.match(reservationHandler, /return \{ requested: 0, reserved: 0 \}/);
});

test("work panel separator exposes internal panel width resizing", () => {
  assert.match(panelSource, /role="separator"/);
  assert.match(panelSource, /aria-label=\{t\("panel\.resize"\)\}/);
  assert.match(panelSource, /aria-valuemin=\{WORK_PANEL_MIN_WIDTH\}/);
  assert.match(panelSource, /aria-valuemax=\{WORK_PANEL_MAX_WIDTH\}/);
  assert.match(panelSource, /aria-valuenow=\{Math\.round\(panelDragWidth \?\? renderPanelWidth\)\}/);
  assert.match(panelSource, /tabIndex=\{0\}/);
  assert.match(panelSource, /startClientX:\s*event\.clientX/);
  assert.match(panelSource, /startWidth/);
  assert.match(panelSource, /startWidth \+ drag\.startClientX - event\.clientX/);
  assert.match(panelSource, /onPointerDown=\{onPanelResizeStart\}/);
  assert.match(panelSource, /requestAnimationFrame/);
  assert.match(panelSource, /event\.key === "ArrowLeft"/);
  assert.match(panelSource, /event\.key === "ArrowRight"/);
  assert.match(panelSource, /event\.key === "Escape" && drag/);
  assert.match(panelSource, /onPointerUp=\{onPanelResizeCommit\}/);
  assert.match(panelSource, /onPointerCancel=\{onPanelResizeCancel\}/);
  assert.match(panelSource, /onLostPointerCapture=\{onPanelResizeCancel\}/);
  assert.match(panelSource, /onKeyDown=\{onPanelResizeKeyDown\}/);
  assert.match(panelSource, /data-work-panel-resizing/);
  assert.match(globalStyles, /\.work-panel-resize \{[^}]*width:\s*10px;/s);
  assert.match(globalStyles, /touch-action:\s*none/);
  assert.match(globalStyles, /\.work-panel-resize:focus-visible/);
});

test("Electron enforces the responsive shell minimum", () => {
  assert.match(mainSource, /const WINDOW_MIN_WIDTH = 1040/);
  assert.match(mainSource, /const WINDOW_MIN_HEIGHT = 700/);
  assert.match(mainSource, /minWidth:\s*WINDOW_MIN_WIDTH/);
  assert.match(mainSource, /minHeight:\s*WINDOW_MIN_HEIGHT/);
});

test("built-in terminal is absent while the work panel keeps its other surfaces", () => {
  assert.doesNotMatch(panelSource, /TerminalTab|terminalOpen|kind: "terminal"/);
  assert.doesNotMatch(panelSource, /work-panel-surface-terminal|activeTab\?\.kind !== "terminal"/);
  assert.match(panelSource, /activeTab\?\.kind === "review"/);
  assert.match(panelSource, /activeTab\?\.kind === "browser"/);
  assert.match(panelSource, /activeTab\?\.kind === "file"/);
  assert.match(transcriptSource, /action === "run"/);
  assert.doesNotMatch(transcriptSource, /openTerminal|terminalArtifact|chat\.openTerminal/);
});

test("workspace artifacts attach review to their originating session", () => {
  const artifactIndex = storeSource.indexOf("shouldOpenReviewArtifact({");
  const openReviewMatch = storeSource.match(
    /get\(\)\.openWorkPanelTabForSession\(\s*envelope\.sessionId,\s*toolWorkPanelTab\("review"\),?\s*\)/,
  );
  const openReviewIndex = openReviewMatch?.index ?? -1;
  const gateIndex = storeSource.indexOf(
    "if (envelope.sessionId !== get().activeSessionId)",
  );
  assert.ok(artifactIndex > -1, "workspace artifact gate exists");
  assert.ok(openReviewIndex > artifactIndex, "review artifact records its session tab");
  assert.ok(gateIndex > -1, "cross-session gate exists");
  assert.ok(
    openReviewIndex < gateIndex,
    "background artifacts must be recorded before the cross-session early-return",
  );
  assert.match(
    storeSource,
    /shouldOpenReviewArtifact\(\{[\s\S]*toolName,[\s\S]*isError:\s*event\.isError,[\s\S]*result:\s*event\.result/s,
  );
  assert.doesNotMatch(
    storeSource.match(/shouldOpenReviewArtifact\(\{[\s\S]*?\}\)/)?.[0] ?? "",
    /activeSessionId|sessionId/,
  );
});

test("work panel context is retained by session instead of cleared on selection", () => {
  assert.match(storeSource, /workPanelContexts:\s*Record<string, WorkPanelContext>/);
  assert.match(storeSource, /openWorkPanelTabForSession:/);
  const selectBlock =
    storeSource.match(/selectSession: async[\s\S]*?\n  newSession:/)?.[0] ?? "";
  assert.match(
    selectBlock,
    /switchWorkPanelSession\([\s\S]*id/,
  );
  assert.doesNotMatch(selectBlock, /resetWorkPanelContext\(\)/);
  assert.match(
    storeSource,
    /workPanelContexts:[\s\S]*workPanelOpen:[\s\S]*workPanelTabs:[\s\S]*activeWorkPanelTabId:[\s\S]*workPanelFileRequest:/,
  );
});

test("file preview request ids stay unique across session contexts", () => {
  assert.match(storeSource, /let workPanelFileRequestSeq = 0/);
  assert.ok(
    storeSource.match(/seq:\s*\+\+workPanelFileRequestSeq/g)?.length >= 3,
    "open and activation paths must use the shared request sequence",
  );
  assert.doesNotMatch(storeSource, /seq:\s*\([^)]*fileRequest\?\.seq[^)]*\) \+ 1/);
});

test("background panel updates do not replace or resize the visible session", () => {
  const openForSessionBlock =
    storeSource.match(
      /openWorkPanelTabForSession: \(sessionId, tab\) => \{[\s\S]*?\n  \},\n  activateWorkPanelTab:/,
    )?.[0] ?? "";
  assert.ok(openForSessionBlock, "session-scoped tab action exists");
  assert.match(
    openForSessionBlock,
    /const affectsVisibleSession\s*=\s*state\.activeSessionId\s*===\s*sessionId\s*&&\s*\(\s*pendingSessionSelection\s*===\s*null\s*\|\|\s*pendingSessionSelection\.id\s*===\s*sessionId\s*\)/,
    "visible-session updates require the active session and matching pending selection",
  );
  assert.match(openForSessionBlock, /workPanelContexts/);
  assert.match(openForSessionBlock, /openWorkPanelTabState/);
  assert.match(
    openForSessionBlock,
    /\.\.\.\(affectsVisibleSession[\s\S]*workPanelOpen:\s*true[\s\S]*:\s*\{\}\)/,
  );
  assert.doesNotMatch(
    openForSessionBlock,
    /setWorkPanelWidth|expandWindowForPanel|windowResizeBy/,
  );
});

test("deleting a session also removes its retained work panel context", () => {
  const deleteBlock =
    storeSource.match(/deleteSession: async[\s\S]*?\n  setSessionSort:/)?.[0] ?? "";
  assert.ok(deleteBlock, "deleteSession action exists");
  assert.match(deleteBlock, /workPanelContexts/);
  assert.match(
    deleteBlock,
    /delete workPanelContexts\[id\]|withoutRecordKey\([^)]*workPanelContexts,\s*id\)/,
  );
});

test("revealing the panel with no tab shows the empty body and its tool list", async () => {
  const emptySource = await readFile(
    new URL("../src/components/workpanel/WorkTabEmpty.tsx", import.meta.url),
    "utf8",
  );
  // `Cmd/Ctrl+J` reveals the panel without creating a tab, so the body must
  // still say something and offer a way forward.
  assert.match(panelSource, /\{!activeTab && \(/);
  assert.match(panelSource, /data-testid="work-panel-empty"/);
  assert.match(panelSource, /panel\.empty\.title/);
  assert.match(panelSource, /panel\.empty\.body/);
  assert.match(panelSource, /className="work-panel-empty-tools"/);
  assert.match(panelSource, /HEADER_TOOLS\.map[\s\S]*work-panel-empty-tool/);
  assert.match(panelSource, /data-action=\{`open-work-panel-\$\{kind\}`\}/);
  assert.match(panelSource, /onClick=\{\(\) => openTool\(kind\)\}/);
  // No tab exists to label a tabpanel, so the empty body is a plain group.
  const emptyBlock = panelSource.match(/\{!activeTab && \([\s\S]*?\n {10}\)\}/)?.[0] ?? "";
  assert.ok(emptyBlock, "the empty body branch is a single JSX block");
  assert.doesNotMatch(emptyBlock, /role="tabpanel"/);
  assert.match(emptyBlock, /role="group"/);
  // Tab empty states share one component so they keep one visual treatment.
  assert.match(emptySource, /work-tab-empty-icon/);
  assert.match(emptySource, /work-tab-empty-title/);
  assert.match(emptySource, /work-tab-empty-body/);
});

test("work panel empty states match the app's other empty-state proportions", () => {
  const icon = globalStyles.match(/\.work-tab-empty-icon \{[^}]*\}/)?.[0] ?? "";
  assert.match(icon, /width: 38px/);
  assert.match(icon, /height: 38px/);
  assert.match(icon, /border-radius: var\(--radius-full\)/);
  assert.match(icon, /color-mix\(in oklab, var\(--ds-text-primary\) 7%, transparent\)/);
  const title = globalStyles.match(/\.work-tab-empty-title \{[^}]*\}/)?.[0] ?? "";
  assert.match(title, /font-size: var\(--text-base-plus\)/);
  assert.match(title, /color: var\(--ds-text-primary\)/);
  const body = globalStyles.match(/\.work-tab-empty-body \{[^}]*\}/)?.[0] ?? "";
  assert.match(body, /font-size: var\(--text-md\)/);
  assert.match(body, /max-width: 34ch/);
  // Entry rows stay as restrained as the header menu rows: fill on hover,
  // a focus ring for keyboard use, and nothing else.
  const tool = globalStyles.match(/\.work-panel-empty-tool \{[^}]*\}/)?.[0] ?? "";
  assert.match(tool, /height: 28px/);
  assert.match(tool, /border-radius: var\(--radius-sm\)/);
  assert.doesNotMatch(tool, /border: 1px/);
  assert.match(globalStyles, /\.work-panel-empty-tool:hover \{\s*background: var\(--ds-bg-hover\);/);
  assert.match(
    globalStyles,
    /\.work-panel-empty-tool:focus-visible \{\s*outline: 2px solid var\(--ds-focus\)/,
  );
});
