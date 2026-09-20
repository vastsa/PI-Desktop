import { readAppSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { readMainSource } from "./helpers/main-source.mjs";
import { readStoreSource } from "./helpers/store-source.mjs";
import { readTranscriptSource } from "./helpers/transcript-source.mjs";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../src/lib/work-panel-resize.ts";
const appSource = await readAppSource();
const mainSource = await readMainSource();
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
const transcriptSource = await readTranscriptSource();
const storeSource = await readStoreSource();
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
  // nav bridge that resized the OS window must stay gone. The i18n key
  // `nav.toggleWorkPanel` (used by the in-app toggle button title) is fine;
  // the bridge channel `IPC.invoke.nav.toggleWorkPanel` is not.
  assert.doesNotMatch(appSource, /IPC\.invoke\.nav\.toggleWorkPanel|navToggleWorkPanel/);
  assert.doesNotMatch(appSource, /key\.toLowerCase\(\) === "j"/);
});

test("a viewport-fixed toggle is the sole pointer collapse control", () => {
  assert.match(appSource, /className="app-work-panel-toggle no-drag"/);
  assert.match(appSource, /aria-pressed=\{workPanelOpen \|\| presentedWorkPanelOpen\}/);
  assert.match(appSource, /togglePresentedWorkPanel/);
  assert.match(appSource, /if \(store\.subagentPanel\) \{\s*store\.toggleWorkPanel\(\);/s);
  assert.doesNotMatch(appSource, /onCollapse=/);
  assert.doesNotMatch(panelSource, /onCollapse/);
  assert.doesNotMatch(panelSource, /work-panel-toolbar-collapse/);
  assert.match(
    globalStyles,
    /\.app-work-panel-toggle \{[^}]*position:\s*fixed;[^}]*z-index:\s*30;/s,
  );
  assert.match(
    globalStyles,
    /--ds-work-panel-toggle-size:\s*28px/,
  );
  assert.match(
    globalStyles,
    /--ds-work-panel-toggle-inset:\s*12px/,
  );
  assert.match(
    globalStyles,
    /--ds-work-panel-control-gap:\s*4px/,
  );
  // One gap for the whole header row: the same token spaces the strip-to-actions
  // gap, the `+`/maximize pair, and the reserve that ends the content one gap
  // before the viewport-fixed toggle.
  assert.doesNotMatch(globalStyles, /--ds-work-panel-toggle-gap/);
  assert.match(
    globalStyles,
    /\.work-panel-header \{[^}]*gap:\s*var\(--ds-work-panel-control-gap\);/s,
  );
  assert.match(
    globalStyles,
    /\.work-panel-header \{[^}]*padding:\s*0\s+calc\([\s\S]*?var\(--ds-work-panel-toggle-size\)[\s\S]*?var\(--ds-work-panel-toggle-inset\)[\s\S]*?var\(--ds-work-panel-control-gap\)[\s\S]*?\)\s+0 12px;/s,
  );
  // The action group states spacing only: the divider, inset, and margin that
  // used to set the three panel buttons apart are gone, so they read as one
  // group with the fixed collapse toggle at the shared control gap.
  assert.match(
    globalStyles,
    /\.work-panel-actions \{[^}]*gap:\s*var\(--ds-work-panel-control-gap\);/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-actions \{[^}]*margin-right:/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-actions \{[^}]*padding-right:/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-actions \{[^}]*border-right:/s,
  );
  // `+` and maximize are chrome icon controls: transparent at rest, hover wash
  // only. A filled tile of their own re-seated the header's quiet group as two
  // filled squares beside the toggle (chrome-control-geometry.test.mjs owns the
  // family and its interaction states).
  assert.match(
    globalStyles,
    /\.work-panel-new-tab,\n\.work-panel-maximize \{[^}]*background:\s*transparent;/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-(?:new-tab|maximize)\s*\{[^}]*background:\s*var\(--ds-tile/,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.app-work-panel-toggle\[aria-pressed="true"\] \{[^}]*box-shadow:/s,
  );
  assert.match(mainSource, /WORK_PANEL_HEADER_PROBE/);
  assert.match(mainSource, /querySelector\('\.work-panel-new-tab'\)/);
  assert.doesNotMatch(mainSource, /work-panel-switcher-trigger/);
  assert.match(mainSource, /probe\.gap < 24/);
  assert.match(mainSource, /pi-panel-new/);
  assert.match(mainSource, /pi-panel-new-dark/);
  assert.match(mainSource, /WORK_PANEL_NEW_PAGE_PROBE/);
  assert.match(mainSource, /data-work-panel-launcher-item/);
  assert.doesNotMatch(mainSource, /WORK_PANEL_MENU_PROBE|pi-panel-browser-menu|pi-panel-menu/);
  assert.match(
    globalStyles,
    /:root\[data-platform="win32"\] \.work-panel-header,[\s\S]*:root\[data-platform="linux"\] \.work-panel-header\s*\{[^}]*margin-right:\s*var\(--ds-window-controls-width\);/,
  );
  // The reservation ends the header's box so its native drag rectangle stops
  // before the control band: padding alone still covers the window controls.
  assert.doesNotMatch(
    globalStyles,
    /padding-right:\s*calc\(var\(--ds-window-controls-width\)/,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="win32"\] \.conversation-topbar\.ct-work-panel-open,[\s\S]*:root\[data-platform="linux"\] \.conversation-topbar\.ct-work-panel-open\s*\{[^}]*right:\s*0;/,
  );
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
  assert.match(mainSource, /setWorkPanelReservationWidth\(0\)/);
  assert.match(mainSource, /return \{ requested: 0, reserved: 0 \}/);
  assert.match(appSource, /commitWorkPanelPresentation/);
  assert.doesNotMatch(appSource, /\.finally\(\(\) => \{[\s\S]*setPresentedWorkPanelOpen/);
  // Mount follows presentation commit; exit keep-alive plays work-panel-out
  // before unmounting, so MainChat reflows continuously in both directions.
  assert.match(
    appSource,
    /<\/section>\s*\)\}\s*\{\(presentedWorkPanelOpen \|\| workPanelExiting\) && \(?\s*<WorkPanel/,
  );
  assert.doesNotMatch(
    appSource,
    /<\/section>\s*\{workPanelOpen && \(?\s*<WorkPanel/,
  );
  assert.match(appSource, /finishWorkPanelExit/);
  assert.match(appSource, /onExitAnimationEnd=\{\(\) =>/);
  assert.match(appSource, /finishWorkPanelExit\(workPanelExitGeneration\.current\)/);
  // Native surfaces hide via `blocked` before work-panel-out starts, so the
  // guest clamped to the plugin view is gone before the dock CSS animation.
  assert.match(
    panelSource,
    /blocked=\{\s*exiting \|\| panelBlocked \|\| blockingOverlayActive\s*\}/,
  );
  assert.match(panelSource, /nativeSurfaceReadyForExit/);
  assert.match(panelSource, /is-exit-pending/);
  assert.match(panelSource, /exitAnimationReady && "is-exiting"/);
  assert.match(panelSource, /if \(!exitAnimationReady\) return/);
  assert.match(panelSource, /animationName\.startsWith\("work-panel-out"\)/);
  assert.match(panelSource, /const renderPanelWidth = layout\.panelWidth/);
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

test("work panel header exposes a scrollable tab strip and direct new-page action", () => {
  const headerIndex = panelSource.indexOf('className="work-panel-header"');
  const stripIndex = panelSource.indexOf('className="work-panel-tab-strip"');
  const actionsIndex = panelSource.indexOf('className="work-panel-actions no-drag"');
  const bodyIndex = panelSource.indexOf('<div className="work-panel-body">');

  assert.ok(stripIndex > headerIndex);
  assert.ok(actionsIndex > stripIndex && bodyIndex > actionsIndex);
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /role="tab"/);
  assert.match(panelSource, /aria-selected=\{selected\}/);
  assert.match(panelSource, /aria-controls=\{`work-panel-surface-\$\{tab\.id\}`\}/);
  assert.match(panelSource, /className="work-panel-tab-close"/);
  assert.match(panelSource, /event\.button !== 1/);
  assert.match(panelSource, /workPanelTools\(t, pluginViews\)/);
  assert.match(panelSource, /toolWorkPanelTab\("review"\)/);
  assert.match(panelSource, /pluginViews\.map\(\(view\) =>/);
  assert.doesNotMatch(panelSource, /HEADER_TOOLS|headerToolTab|HeaderToolKind/);
  // Launchable tools are plugin views (`pi.file-manager`, `pi.browser`, …). The
  // `file` *kind* remains: a `file:<path>` tab is a transcript artifact.
  assert.doesNotMatch(panelSource, /\{ kind: "file", Icon/);
  assert.match(panelSource, /onClick=\{openNewWorkPanelTab\}/);
  assert.match(panelSource, /data-work-panel-launcher-item=\{item\.id\}/);
  assert.doesNotMatch(panelSource, /aria-haspopup|work-panel-new-menu|role="menuitemradio"/);
  assert.match(panelSource, /role="tabpanel"/);
  assert.match(panelSource, /className="work-panel-subagent-back"/);
  assert.match(panelSource, /IconChevronLeft/);
  // Reopening an already-open plugin view must reuse its tab so the browser
  // keeps its location instead of being replaced by a blank singleton.
  assert.match(
    panelSource,
    /const existing = tabs\.find\(\(tab\) => tab\.id === item\.tab\.id\)/,
  );
  assert.match(panelSource, /if \(existing\) activateTab\(existing\.id\)/);
  assert.doesNotMatch(panelSource, /collapsePanel/);
  assert.doesNotMatch(panelSource, /work-panel-collapse/);
  assert.doesNotMatch(panelSource, /onCollapse/);
  assert.doesNotMatch(panelSource, /work-panel-toolbar-collapse/);
  assert.match(panelSource, /panel\.tabs\.file/);
  // Every native surface in the panel — the preview browser and each plugin
  // view — composites above the renderer. Exit and panel-wide overlays hide
  // it; the launcher is rendered in the panel body and needs no floating layer.
  const pluginSurfaceStart = panelSource.indexOf("<PluginViewTab");
  const pluginSurfaceEnd = panelSource.indexOf("/>", pluginSurfaceStart);
  const pluginSurface = panelSource.slice(pluginSurfaceStart, pluginSurfaceEnd);
  assert.match(
    pluginSurface,
    /blocked=\{\s*exiting \|\| panelBlocked \|\| blockingOverlayActive\s*\}/s,
  );
  assert.doesNotMatch(pluginSurface, /isResizing/);
  assert.doesNotMatch(panelSource, /createPortal|newTabMenuRef|menuOpen/);
  assert.doesNotMatch(panelSource, /onContextMenu|work-panel-context-menu/);
  assert.doesNotMatch(globalStyles, /work-panel-new-menu|work-panel-menu-item|work-panel-open-dot/);
  assert.match(globalStyles, /\.work-panel-tab-strip \{[^}]*overflow-x:\s*auto;/s);
  assert.match(globalStyles, /\.work-panel-tab-strip \{[^}]*gap:\s*6px;/s);
  assert.match(
    globalStyles,
    /\.work-panel-tab \{[^}]*min-width:\s*92px;[^}]*flex:\s*0 0 auto;/s,
  );
  assert.doesNotMatch(globalStyles, /\.work-panel-actions \{[^}]*margin-left:\s*auto;/s);
  assert.doesNotMatch(
    globalStyles,
    /\.work-panel-create-item|\.work-panel-switcher-(?:row|item|close|list|title)/,
  );
});

test("plus creates a blank page and launcher rows open tools in that page", () => {
  assert.match(panelSource, /openNewWorkPanelTab/);
  assert.match(panelSource, /activeTab\?\.kind === "new"/);
  assert.match(panelSource, /replaceWorkPanelTab/);
  assert.match(storeSource, /openNewWorkPanelTab: \(\) =>/);
  assert.match(storeSource, /replaceWorkPanelTab: \(sourceTabId, tab\) =>/);
  assert.match(storeSource, /replaceWorkPanelTabState/);
  assert.doesNotMatch(panelSource, /setMenuOpen|menuOpen|newTabMenuRef|createPortal/);
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

test("closing the final tab keeps the panel open for the New launcher", () => {
  const closeBlock = storeSource.slice(
    storeSource.indexOf("closeWorkPanelTab: (tabId) =>"),
    storeSource.indexOf(
      "openWorkPanelTabForSession:",
      storeSource.indexOf("closeWorkPanelTab: (tabId) =>"),
    ),
  );
  assert.doesNotMatch(closeBlock, /closePanel/);
  assert.match(closeBlock, /nextContext[\s\S]*open:\s*state\.workPanelOpen/);
  assert.match(closeBlock, /workPanelOpen:\s*state\.workPanelOpen/);
  assert.match(panelSource, /panel\.new\.title/);
  assert.match(panelSource, /work-panel-launcher/);
});

test("work panel width is renderer-owned inside the fixed window", () => {
  assert.equal(MAIN_PANE_MIN_WIDTH, 450);
  assert.equal(WORK_PANEL_DEFAULT_WIDTH, 360);
  assert.equal(WORK_PANEL_MIN_WIDTH, 244);
  assert.match(panelSource, /const renderPanelWidth = layout\.panelWidth/);
  assert.match(panelSource, /setWidth\(drag\.currentWidth\)/);
  assert.match(panelSource, /startWidth \+ drag\.startClientX - event\.clientX/);
  assert.doesNotMatch(panelSource, /api\.setWorkPanelChatWidth/);
  assert.doesNotMatch(panelSource, /api\.onWorkPanelResize/);
  assert.doesNotMatch(panelSource, /\.sidebar, \.sidebar-rail/);
  assert.match(
    globalStyles,
    /\.main-pane \{[^}]*min-width:\s*var\(--ds-main-pane-min-width, 450px\);/s,
  );
  assert.match(
    globalStyles,
    /\.chat-surface,[\s\S]*?\.route-page \{[^}]*min-width:\s*var\(--ds-main-pane-min-width, 450px\);/s,
  );
  assert.match(globalStyles, /\.work-panel \{[^}]*flex: 0 0 var\(--work-panel-width\)/s);
  // The Electron seam remains available for old callers but is deliberately
  // inert, so no positive target can expand the native window.
  const reservationHandler = mainSource.slice(
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelReservation"),
    mainSource.indexOf("IPC.invoke.windowSetWorkPanelChatWidth"),
  );
  assert.match(reservationHandler, /setWorkPanelReservationWidth\(0\)/);
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
  assert.match(panelSource, /aria-valuemin=\{Math\.min\(/);
  assert.match(panelSource, /aria-valuemax=\{Math\.max\(/);
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
  assert.match(panelSource, /onDoubleClick=\{onPanelResizeReset\}/);
  assert.match(
    panelSource,
    /if \(drag\) finishPanelResize\(event\.currentTarget, drag\.pointerId, true\)/,
  );
  assert.match(panelSource, /workPanelResetWidth\(panelMinimum, layout\.maxPanelWidth\)/);
  assert.match(panelSource, /workPanelWidthBounds\(/);
  assert.match(panelSource, /data-work-panel-resizing/);
  assert.match(globalStyles, /\.work-panel-resize \{[^}]*width:\s*10px;/s);
  assert.match(globalStyles, /touch-action:\s*none/);
  assert.match(globalStyles, /\.work-panel-resize:focus-visible/);
  // Same short grip as the sidebar: 32px, centered, no full-height rail.
  const resizeMarker =
    globalStyles.match(/\.work-panel-resize::after\s*\{[^}]+\}/s)?.[0] ?? "";
  assert.match(resizeMarker, /top:\s*50%/);
  assert.match(resizeMarker, /height:\s*32px/);
  assert.match(resizeMarker, /border-radius:\s*var\(--radius-full\)/);
  assert.match(globalStyles, /\.work-panel-resize:hover::after,/);
  assert.match(
    globalStyles,
    /\.work-panel-resize:focus-visible::after,[\s\S]*?background:\s*var\(--ds-accent\)/,
  );
});

test("Electron enforces the responsive shell minimum", () => {
  assert.match(mainSource, /const WINDOW_MIN_WIDTH = 1040/);
  assert.match(mainSource, /const WINDOW_MIN_HEIGHT = 700/);
  // The window creation clamps the minimum to fit the current work area, so
  // the props are the clamped `initialMin*` values, both derived from
  // `windowMin*` via `Math.min(windowMin*, restoreWorkArea.*)`.
  assert.match(mainSource, /minWidth:\s*initialMinWidth/);
  assert.match(mainSource, /minHeight:\s*initialMinHeight/);
  assert.match(mainSource, /initialMinWidth = Math\.min\(windowMinWidth/);
  assert.match(mainSource, /initialMinHeight = Math\.min\(windowMinHeight/);
});

test("built-in terminal is absent while the work panel keeps its other surfaces", () => {
  assert.doesNotMatch(panelSource, /TerminalTab|terminalOpen|kind: "terminal"/);
  assert.doesNotMatch(panelSource, /work-panel-surface-terminal|activeTab\?\.kind !== "terminal"/);
  assert.match(panelSource, /activeTab\?\.kind === "review"/);
  assert.match(panelSource, /activeTab\?\.kind === "plugin"/);
  assert.match(panelSource, /activeTab\?\.kind === "file"/);
  assert.match(transcriptSource, /action === "run"/);
  assert.doesNotMatch(transcriptSource, /openTerminal|terminalArtifact|chat\.openTerminal/);
});

test("tool results never open the Review tab on their own", () => {
  // Review opens only from an explicit user action: the viewport toggle
  // reveals the retained context and the `+` launcher lists its row. A
  // successful Write/Edit may not record, activate, or reveal a tab for any
  // session, visible or background.
  assert.doesNotMatch(storeSource, /shouldOpenReviewArtifact/);
  assert.doesNotMatch(
    storeSource,
    /openWorkPanelTabForSession\([\s\S]{0,120}toolWorkPanelTab\("review"\)/,
  );
  assert.match(storeSource, /openWorkPanelTabForSession:/);
});

test("work panel context is retained by session instead of cleared on selection", () => {
  assert.match(storeSource, /workPanelContexts:\s*Record<string, WorkPanelContext>/);
  assert.match(storeSource, /openWorkPanelTabForSession:/);
  const selectBlock =
    storeSource.match(/selectSession: async[\s\S]*?\n\s+newSession:/)?.[0] ?? "";
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
    /const affectsVisibleSession\s*=\s*state\.activeSessionId\s*===\s*sessionId\s*&&\s*\(\s*!isSessionSelectionPending\(sessionId\)\s*\)/,
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
  // The cleanup is one shared helper so session and project deletion cannot
  // drift apart, so the contract is asserted on the helper itself.
  const cleanupBlock =
    storeSource.match(/function clearLocalSessionState\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(cleanupBlock, "local session cleanup helper exists");
  assert.match(cleanupBlock, /workPanelContexts/);
  assert.match(
    cleanupBlock,
    /delete workPanelContexts\[id\]|withoutRecordKey\([^)]*workPanelContexts,\s*id\)/,
  );
  const deleteBlock =
    storeSource.match(/deleteSession: async[\s\S]*?\n\s+setSessionSort:/)?.[0] ?? "";
  assert.ok(deleteBlock, "deleteSession action exists");
  assert.match(deleteBlock, /clearLocalSessionState\(/);
});

test("the panel and a new tab share the same launcher rows", async () => {
  const emptySource = await readFile(
    new URL("../src/components/workpanel/WorkTabEmpty.tsx", import.meta.url),
    "utf8",
  );
  // `Cmd/Ctrl+J` reveals the panel without creating a tab, while `+` creates
  // an explicit launcher tab. Both states offer the same tool rows.
  assert.match(panelSource, /!subagentPanel && \(!activeTab \|\| activeTab\.kind === "new"\)/);
  assert.match(panelSource, /data-testid="work-panel-empty"/);
  assert.match(panelSource, /panel\.new\.title/);
  assert.match(panelSource, /panel\.toolsAndPanels/);
  assert.match(panelSource, /className="work-panel-launcher"/);
  assert.match(panelSource, /className="work-panel-launcher-row"/);
  assert.match(panelSource, /tools\.map\(\(item\) =>/);
  assert.doesNotMatch(panelSource, /panel\.empty\.title|panel\.empty\.body/);
  assert.doesNotMatch(panelSource, /work-panel-empty-tools|openPluginView\(view\)/);
  // The explicit New tab gets a labelled tabpanel; the legacy no-tab reveal
  // remains a plain body with a labelled launcher group.
  assert.match(panelSource, /role=\{activeTab \? "tabpanel" : undefined\}/);
  assert.match(panelSource, /role="group"/);
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
  // Launcher rows stay compact and keyboard-visible.
  const tool = globalStyles.match(/\.work-panel-launcher-row \{[^}]*\}/)?.[0] ?? "";
  assert.match(tool, /height: 40px/);
  assert.match(tool, /border-radius: var\(--radius-sm\)/);
  assert.doesNotMatch(tool, /border: 1px/);
  assert.match(globalStyles, /\.work-panel-launcher-row:hover \{\s*background: var\(--ds-bg-hover\);/);
  assert.match(
    globalStyles,
    /\.work-panel-launcher-row:focus-visible \{\s*outline: 2px solid var\(--ds-focus\)/,
  );
});

test("the shell budgets the three columns inside the fixed client area", () => {
  // MainChat is the first-priority column: the panel is capped by the shared
  // budget and the expanded sidebar is the column that yields.
  assert.equal(MAIN_PANE_MIN_WIDTH, 450);
  assert.match(
    globalStyles,
    /\.main-pane \{[^}]*min-width:\s*var\(--ds-main-pane-min-width, 450px\);/s,
  );
  assert.match(
    globalStyles,
    /\.chat-surface,[\s\S]*?\.route-page \{[^}]*min-width:\s*var\(--ds-main-pane-min-width, 450px\);/s,
  );
  assert.match(panelSource, /const renderPanelWidth = layout\.panelWidth/);
  assert.match(panelSource, /maxWidth: layout\.maxPanelWidth/);
  assert.match(panelSource, /sidebarOccupiesBudget = !sidebarCollapsed \|\| sidebarExiting/);
  assert.match(panelSource, /layout\.shouldCollapseSidebar\) onAutoCollapseSidebar/);
  assert.match(appSource, /onAutoCollapseSidebar=\{autoCollapseSidebar\}/);
  assert.match(appSource, /containerWidth=\{shellWidth\}/);
  assert.match(appSource, /sidebarExiting=\{sidebarExiting\}/);
  assert.match(appSource, /workPanelWidthForSidebarReopen/);
  assert.match(appSource, /if \(sidebarCollapsedRef\.current\) reopenSidebar\(\)/);
  // The window itself never changes: the native reservation seam stays at
  // zero and no committed panel width is mirrored through it.
  assert.match(appSource, /setWorkPanelReservation\(0\)/);
  assert.doesNotMatch(appSource, /setWorkPanelReservation\(Math\.round\(/);
});

test("preview mode keeps shell actions and restores routes before navigation", () => {
  assert.match(appSource, /className=\{cx\([\s\S]*?"window-chrome-row"/);
  assert.match(appSource, /data-nav="new-task"/);
  assert.match(appSource, /<CollapsedTitlebarActions[\s\S]*?onNewTask=/);
  assert.match(appSource, /\{ready && !showSplash && <WindowControls \/>\}/);
  assert.match(appSource, /const workPanelMaximizedRef = useRef\(false\)/);
  assert.match(
    appSource,
    /if \(workPanelOpenRef\.current && !workPanelMaximizedRef\.current\)/,
  );
  assert.match(
    appSource,
    /if \(workPanelMaximized && page !== "chat"\) \{\s*setWorkPanelMaximized\(false\);/s,
  );
  assert.match(
    appSource,
    /case "newTask":[\s\S]*?if \(workPanelMaximizedRef\.current\) setWorkPanelMaximized\(false\);/,
  );
  const row = globalStyles.match(/\.window-chrome-row \{[^}]*\}/)?.[0] ?? "";
  const spacer = globalStyles.match(/\.window-chrome-drag \{[^}]*\}/)?.[0] ?? "";
  assert.match(row, /pointer-events:\s*none/);
  assert.match(row, /padding-left:\s*var\(--preview-chrome-inset\)/);
  assert.ok(spacer);
  assert.doesNotMatch(row + spacer, /app-region:|background:/);
  assert.match(globalStyles, /\.window-chrome-row button \{[^}]*pointer-events:\s*auto;[^}]*app-region:\s*no-drag;/);
  assert.match(globalStyles, /\.window-chrome-row\.sidebar-expanded \{[^}]*left: var\(--ds-sidebar-width\);/);
  assert.match(globalStyles, /\.app-shell\.work-panel-maximized \{[^}]*--preview-chrome-inset:\s*8px;[^}]*--preview-chrome-action-lane:\s*calc\(var\(--ds-control-size\) \+ 8px\);/);
  assert.match(globalStyles, /\.app-shell\.work-panel-maximized\.sidebar-collapsed \{[^}]*--preview-chrome-action-lane:\s*var\(--ds-preview-action-lane-width\);/);
  assert.match(globalStyles, /:root\[data-platform="darwin"\] \.app-shell\.work-panel-maximized\.sidebar-collapsed \{[^}]*--preview-chrome-inset:\s*var\(--ds-window-lead-inset\);/);
  assert.match(globalStyles, /\.app-shell\.work-panel-maximized \.work-panel-header \{[^}]*margin-left:\s*calc\(var\(--preview-chrome-inset\) \+ var\(--preview-chrome-action-lane\)\);[^}]*padding-left:\s*0;/);
  assert.match(globalStyles, /\.work-panel-header \{[^}]*app-region:\s*drag;/);
  assert.match(globalStyles, /\.app-shell\.work-panel-maximized \.work-panel-main \{[^}]*var\(--ds-bg-dock-raised\) 0 var\(--ds-toolbar-height\)/);
});
