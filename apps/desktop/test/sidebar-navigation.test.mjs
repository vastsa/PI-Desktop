import { readAppSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const hoverSource = await readFile(
  new URL("../src/features/sessions/SessionHoverCard.tsx", import.meta.url),
  "utf8",
);
const hoverHookSource = await readFile(
  new URL("../src/features/sessions/useSessionHoverCard.ts", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const appSource = await readAppSource();
const panelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const shortcutSource = await readFile(
  new URL("../../../packages/shared/src/keyboard-shortcuts.ts", import.meta.url),
  "utf8",
);
test("home sidebar exposes only the supported destination entries", () => {
  assert.match(sidebarSource, /data-nav="home"/);
  assert.match(sidebarSource, /data-nav="plugins"/);
  assert.doesNotMatch(sidebarSource, /data-nav="projects"/);
  assert.match(sidebarSource, /data-nav="scheduled"/);
  assert.doesNotMatch(sidebarSource, /t\("nav\.scheduled"\)/);
});

test("sidebar brand returns to the chat home", () => {
  const brandButton = sidebarSource.match(
    /<TooltipButton\s+type="button"\s+className="brand no-drag"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";

  assert.match(brandButton, /data-nav="home"/);
  assert.match(brandButton, /ariaLabel=\{t\("nav\.home"\)\}/);
  assert.match(brandButton, /onClick=\{\(\) => setPage\("chat"\)\}/);
  assert.match(brandButton, /<BrandLogo size=\{20\}/);
  assert.match(brandButton, /t\("app\.shellName"\)/);
});

test("sidebar header retains non-mac branding and collapse without a search control", () => {
  const header = sidebarSource.match(
    /<div className="sidebar-header">[\s\S]*?<\/div>\s*<\/div>/,
  )?.[0] ?? "";

  assert.match(header, /className="brand no-drag"/);
  assert.match(header, /className="sidebar-header-actions no-drag"/);
  assert.doesNotMatch(header, /IconSearch/);
  assert.match(header, /<IconSidebar/);
  assert.match(header, /data-nav="toggle-sidebar"/);
  assert.doesNotMatch(appSource, /IconChevronLeft|IconChevronRight/);
});

test("work panel collapse control is the viewport-fixed shell toggle", () => {
  assert.match(appSource, /className="app-work-panel-toggle no-drag"/);
  assert.match(appSource, /collapseWorkPanel\(\)/);
  assert.doesNotMatch(panelSource, /onCollapse/);
  assert.doesNotMatch(panelSource, /work-panel-toolbar-collapse/);
  assert.doesNotMatch(panelSource, /work-panel-collapse/);
  assert.doesNotMatch(panelSource, /collapsePanel/);
  assert.match(
    globalStyles,
    /\.main-titlebar\.work-panel-open\s*\{[^}]*padding-right:\s*0;/s,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="win32"\] \.main-titlebar\.work-panel-open,[\s\S]*:root\[data-platform="linux"\] \.main-titlebar\.work-panel-open\s*\{[^}]*right:\s*0;/,
  );
  // The reservation is platform-scoped; the base header rule stays neutral.
  assert.doesNotMatch(
    globalStyles,
    /^\.work-panel-header\s*\{[^}]*margin-right:/ms,
  );
});

test("macOS hides sidebar branding and keeps header actions beside traffic lights", () => {
  assert.doesNotMatch(sidebarSource, /sidebar-macos-drag-row/);
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.sidebar-header\s*\{[^}]*padding-left:\s*var\(--ds-window-lead-inset\);/s,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.sidebar-header > \.brand\s*\{[^}]*display:\s*none;/s,
  );
  assert.match(
    globalStyles,
    /\.sidebar-header-actions\s*\{[^}]*margin-left:\s*auto;/s,
  );
});

test("destination history is available through shortcuts without titlebar buttons", () => {
  assert.match(shortcutSource, /id: "navigateBack"[\s\S]*?"Mod\+BracketLeft"/);
  assert.match(appSource, /case "navigateBack"/);
  assert.match(appSource, /useAppStore\.getState\(\)\.navBack\(\)/);
  assert.match(shortcutSource, /id: "navigateForward"[\s\S]*?"Mod\+BracketRight"/);
  assert.match(appSource, /case "navigateForward"/);
  assert.match(appSource, /useAppStore\.getState\(\)\.navForward\(\)/);
  assert.doesNotMatch(appSource, /title=\{t\("nav\.(?:back|forward)"\)\}/);
});

test("sidebar shows a bounded standalone session list before retained projects", () => {
  const newProjectAction = sidebarSource.match(
    /<div[\s\S]*?className="sidebar-list-toolbar"[\s\S]*?data-action="new-project"[\s\S]*?<\/div>/,
  )?.[0] ?? "";
  const standaloneSessions = sidebarSource.match(
    /data-sidebar-session-section="temporary"[\s\S]*?<\/section>/,
  )?.[0] ?? "";

  assert.match(newProjectAction, /t\("nav\.projects"\)/);
  assert.match(newProjectAction, /<IconNewProject/);
  assert.match(newProjectAction, /openProjectPicker\(\)/);
  assert.match(standaloneSessions, /t\("nav\.sessions"/);
  assert.match(standaloneSessions, /data-action="new-standalone-session"/);
  assert.match(standaloneSessions, /createSession\(\{ projectPath: null \}\)/);
  assert.match(standaloneSessions, /renderSessionRows\(temporarySessionHistory/);
  assert.ok(
    sidebarSource.indexOf('data-sidebar-session-section="temporary"') <
      sidebarSource.indexOf('data-action="new-project"'),
  );
  assert.match(
    globalStyles,
    // `[^}]*`, not `[\s\S]*?`: the assertion must read this block, not a
    // `max-height` in some later partial of the concatenated stylesheet.
    /\.sidebar-session-group-body\.standalone\s*\{[^}]*max-height:\s*146px;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/,
  );
  assert.doesNotMatch(sidebarSource, /data-sidebar-project-group="temporary"/);
});

test("sidebar project and session lists stay coordinated with the global type scale", () => {
  assert.match(
    globalStyles,
    /\.thread-item-title\s*\{[^}]*font-size:\s*var\(--text-md\);/s,
  );
  assert.match(
    globalStyles,
    /\.sidebar-session-group-title\s*\{[^}]*font-size:\s*var\(--text-md\);/s,
  );
  assert.match(
    globalStyles,
    /\.sidebar-session-empty\s*\{[^}]*font-size:\s*var\(--text-md\);/s,
  );
});

test("a project row leads with one fixed-width folder box and no pin badge", () => {
  // The folder reports disclosure, so there is no chevron. The wrapper — not
  // the folder — is the flex item, so the box is 13px and the title keeps one
  // left edge. Pinning is not marked on the row at all: a pinned project lives
  // in its own group above the list, so a badge here would only repeat it.
  assert.match(
    sidebarSource,
    /<span className="sidebar-project-glyph" aria-hidden>[\s\S]*?collapsedProject \? \([\s\S]*?<IconFolder size=\{13\} aria-hidden \/>[\s\S]*?\) : \([\s\S]*?<IconFolderOpen size=\{13\} aria-hidden \/>[\s\S]*?<\/span>/,
  );
  assert.doesNotMatch(sidebarSource, /sidebar-disclosure-icon/);
  assert.doesNotMatch(sidebarSource, /className="sidebar-project-pin"/);
  assert.doesNotMatch(sidebarSource, /sidebar-project-folder/);

  assert.match(
    globalStyles,
    /\.sidebar-project-glyph\s*\{[^}]*position:\s*relative;[^}]*width:\s*13px;[^}]*flex:\s*0 0 13px;/s,
  );
  // The badge and its old rule are both gone; the star/pin glyph is not
  // smuggled back in beside the folder.
  assert.doesNotMatch(globalStyles, /\.sidebar-project-pin/);
  assert.doesNotMatch(globalStyles, /\.sidebar-project-folder/);
});

test("sidebar section toolbars open create actions from context menus", () => {
  assert.match(sidebarSource, /data-sidebar-section=\"sessions\"/);
  assert.match(sidebarSource, /data-sidebar-section=\"projects\"/);
  assert.match(sidebarSource, /openSectionMenu\(\"sessions\"/);
  assert.match(sidebarSource, /openSectionMenu\(\"projects\"/);
  assert.match(sidebarSource, /data-sidebar-section-menu=\{sectionMenu\}/);
  assert.match(
    sidebarSource,
    /className=\"sidebar-row-menu sidebar-floating-menu sidebar-section-menu\"/,
  );
  assert.match(sidebarSource, /e\.button === 2/);
  assert.match(sidebarSource, /addEventListener\("pointerdown"/);
});

test("sidebar floating menus open to the anchor's right", () => {
  const triggerPlacement = sidebarSource.match(
    /const placeMenu = useCallback\([\s\S]*?\n  }, \[\]\);/,
  )?.[0] ?? "";
  const pointPlacement = sidebarSource.match(
    /const placeMenuAtPoint = useCallback\([\s\S]*?\n  }, \[\]\);/,
  )?.[0] ?? "";

  assert.match(triggerPlacement, /left:\s*Math\.max\(/);
  assert.match(triggerPlacement, /rect\.right \+ 4/);
  assert.doesNotMatch(triggerPlacement, /window\.innerWidth/);
  assert.doesNotMatch(triggerPlacement, /right:\s*Math\.max/);
  assert.match(pointPlacement, /left:\s*Math\.max\(/);
  assert.match(pointPlacement, /x \+ 4/);
  assert.doesNotMatch(pointPlacement, /window\.innerWidth/);
  assert.match(sidebarSource, /placeMenuAtPoint\(event\.clientX, event\.clientY\)/);
  assert.match(sidebarSource, /left: menuPosition\.left/);
  assert.doesNotMatch(sidebarSource, /right: menuPosition\.right/);
});

test("portaled sort menu does not stretch to the viewport edge", () => {
  const basePopoverRule = globalStyles.match(
    /\.sidebar-row-menu,\n\.sidebar-popover\s*\{[^}]*\}/s,
  )?.[0] ?? "";
  const floatingPopoverRule =
    globalStyles.match(/\.sidebar-popover\.sidebar-floating-menu\s*\{[^}]*\}/s)?.[0] ?? "";

  assert.match(basePopoverRule, /position:\s*fixed;/);
  assert.doesNotMatch(basePopoverRule, /position:\s*absolute;/);
  assert.match(floatingPopoverRule, /top:\s*auto;/);
  assert.match(floatingPopoverRule, /right:\s*auto;/);
  assert.match(globalStyles, /\.sidebar-floating-menu\s*\{[^}]*width:\s*max-content;/s);
  assert.match(globalStyles, /\.sidebar-floating-menu\s*\{[^}]*max-width:\s*calc\(100vw - 16px\);/s);
});

test("sessions toolbar puts sorting before new-session creation", () => {
  const sortIndex = sidebarSource.indexOf('data-action="session-sort"');
  const newSessionIndex = sidebarSource.indexOf('data-action="new-standalone-session"');

  assert.ok(sortIndex >= 0);
  assert.ok(newSessionIndex >= 0);
  assert.ok(sortIndex < newSessionIndex);
});

test("sidebar action icons stay quiet until their toolbar or row is hovered", () => {
  const toolbarButton = globalStyles.match(
    /\.sidebar-toolbar-button\s*\{[^}]+\}/s,
  )?.[0] ?? "";
  assert.match(toolbarButton, /opacity:\s*0/);
  assert.match(
    globalStyles,
    /\.sidebar-list-toolbar:hover \.sidebar-toolbar-button,[\s\S]*?\.sidebar-list-toolbar:focus-within \.sidebar-toolbar-button,[\s\S]*?opacity:\s*1;/,
  );
  assert.match(globalStyles, /\.thread-item:hover \.thread-item-action,/);
  assert.match(
    globalStyles,
    /\.sidebar-session-group-header:hover \.thread-item-action,[\s\S]*?\.sidebar-session-group-header:focus-within \.thread-item-action,/,
  );
  assert.match(
    globalStyles,
    /\.sidebar-session-group-header:hover \.sidebar-session-group-add,[\s\S]*?\.sidebar-session-group-header:focus-within \.sidebar-session-group-add,[\s\S]*?opacity:\s*1;/,
  );
});

test("project rows expose folder actions and full-path hover", () => {
  assert.match(sidebarSource, /data-action="open-project-folder"/);
  assert.match(sidebarSource, /api\.openProjectFolder\(entry\.path\)/);
  assert.doesNotMatch(sidebarSource, /data-action="edit-project-instructions"/);
  assert.doesNotMatch(sidebarSource, /<ProjectInstructionsDialog/);
  assert.doesNotMatch(sidebarSource, /data-action="open-session-folder"/);
  assert.doesNotMatch(sidebarSource, /api\.openSessionFolder\(/);
  assert.match(
    sidebarSource,
    /className="sidebar-session-group-title project-toggle"[\s\S]*?tooltip=\{entry\.path\}[\s\S]*?tooltipDelayMs=\{500\}[\s\S]*?aria-describedby=\{`\$\{projectId\}-path-description`\}/,
  );
  assert.match(sidebarSource, /<TooltipButton/);
  assert.match(globalStyles, /\.ui-tooltip-path\s*\{[^}]*width:\s*max-content/);
  assert.match(globalStyles, /\.ui-tooltip-path\s*\{[^}]*max-width:\s*min\(420px,\s*calc\(100vw - 16px\)\)/);
  assert.match(sidebarSource, /className="sr-only">\s*\{entry\.path\}/);
});

test("sidebar row menus omit project reassignment and switching actions", () => {
  assert.doesNotMatch(sidebarSource, /data-action="move-session-to-project"/);
  assert.doesNotMatch(sidebarSource, /t\("nav\.moveToProject"/);
  assert.doesNotMatch(sidebarSource, /t\("project\.switch"/);
  assert.match(
    sidebarSource,
    /if \(!entry\.active && !\(await selectProject\(entry\.path\)\)\) return;/,
  );
});

test("session rows line their title up with the project name in every state", () => {
  const sessionMain = sidebarSource.match(
    /className="thread-item-main"[\s\S]*?<\/button>/,
  )?.[0] ?? "";

  // A reserved but unpainted slot: a plain row keeps its bare leading edge,
  // while the row stays on the same x as a project name either way.
  assert.match(sessionMain, /className="thread-item-slot"/);
  assert.match(sessionMain, /!status && pinned \? <IconPin size=\{13\} fill="none" className="thread-item-pin"/);
  assert.doesNotMatch(sessionMain, /thread-item-glyph/);
  // A text badge has no fixed width for the slot, so it follows the title.
  assert.match(
    sessionMain,
    /<span className="thread-item-title">[\s\S]*?<span className="thread-item-source"/,
  );
  assert.match(
    globalStyles,
    /\.thread-item-slot\s*\{[^}]*width:\s*13px;[^}]*flex:\s*0 0 13px;/s,
  );
  // The title inset matches the project title's, so 2px + 6px puts the slot on
  // the folder's x and 8px + 13px + 5px puts the title on the project name's x.
  assert.match(
    globalStyles,
    /\.thread-item-main\s*\{[^}]*padding:\s*5px 6px;/s,
  );
  // The permission / completed / failed glyphs borrow that same box, so they
  // read as the project folder's own leading affordance.
  assert.match(
    globalStyles,
    /\.thread-item-status\s*\{[^}]*width:\s*13px;[^}]*left:\s*8px;/s,
  );
});

test("session rows use the hover card instead of a native title tooltip", () => {
  const sessionMain = sidebarSource.match(
    /className="thread-item-main"[\s\S]*?<\/button>/,
  )?.[0] ?? "";

  assert.match(sessionMain, /showSessionHoverCard\(/);
  assert.doesNotMatch(sessionMain, /title=\{taskTitle\(session\.title\)\}/);
  assert.doesNotMatch(sessionMain, /\btitle=\{/);
  assert.match(hoverSource, /className="sidebar-session-hover-card"/);
  assert.match(hoverSource, /className="sidebar-session-hover-card-title"/);
  assert.match(sessionMain, /onFocusCapture=/);
  assert.match(sessionMain, /aria-describedby=/);
  assert.match(hoverHookSource, /\}, 500\)/);
  assert.match(hoverHookSource, /event\.key === "Escape"/);
  assert.match(hoverHookSource, /addEventListener\("scroll", hide, true\)/);
  assert.match(hoverHookSource, /addEventListener\("visibilitychange", onVisibility\)/);
});

test("session hover cards expose readable models and keyboard-navigable session links", () => {
  assert.match(hoverSource, /role="dialog"/);
  assert.match(hoverSource, /summary\?\.modelName \|\| summary\?\.providerName/);
  assert.doesNotMatch(hoverSource, /modelKey\?\.includes\("\/"\)/);
  assert.doesNotMatch(hoverSource, /sidebar-session-hover-card-id/);
  assert.doesNotMatch(hoverSource, /sessionCollaboration\.checkedAt/);
  assert.doesNotMatch(hoverSource, /sessionCollaboration\.provider/);
  assert.doesNotMatch(hoverSource, /nav\.hoverCardLocalTask/);
  assert.match(hoverSource, /data-session-link=\{summary\.createdBySession\.sessionId\}/);
  assert.match(hoverSource, /summary\.createdSessions\.slice\(0, 8\)/);
  assert.match(hoverSource, /type="button"/);
  assert.match(hoverSource, /onClick=\{\(\) => openSessionReference/);
  assert.match(hoverSource, /onFocusCapture=\{keepVisible\}/);
  assert.match(hoverHookSource, /setTimeout\(\(\) => \{[\s\S]*?hide\(\);[\s\S]*?\}, 160\)/);
  assert.match(globalStyles, /\.sidebar-session-hover-card\s*\{[\s\S]*?pointer-events:\s*auto;/);
  assert.match(globalStyles, /\.sidebar-session-hover-card-session-link:focus-visible\s*\{[\s\S]*?outline:/);
});

test("related session links show only active running state", () => {
  assert.match(sidebarSource, /<SessionHoverCard[\s\S]*?runningSessions=\{runningSessions\}/);
  assert.match(sidebarSource, /<SessionHoverCard[\s\S]*?pendingPermissions=\{pendingPermissions\}/);
  assert.match(hoverSource, /sessionReferenceIsRunning\(reference, runningSessions, pendingPermissions\)/);
  assert.match(hoverSource, /data-session-running="true"/);
  assert.match(globalStyles, /\.sidebar-session-hover-card-session-link-status\s*\{[\s\S]*?--ds-warning/);
  assert.match(globalStyles, /\.sidebar-session-hover-card-session-link-status::before\s*\{[\s\S]*?sidebar-status-breathe/);
});

test("hidden row actions stay out of the row's click path", () => {
  // Resting state: the invisible control is not a pointer target at all.
  assert.match(
    globalStyles,
    /\.thread-item-action\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*\}/s,
  );
  assert.match(
    globalStyles,
    /\.thread-item:focus-within \.thread-item-action,\s*\n\.thread-item-action:focus-visible\s*\{[^}]*pointer-events:\s*auto;/s,
  );
  // Without hover there is no reveal, so a no-hover pointer gets the controls
  // visible and tappable instead of an invisible gutter.
  assert.match(
    globalStyles,
    /@media \(hover: none\)\s*\{[\s\S]*?\.sidebar-row-actions \.thread-item-action,[\s\S]*?opacity:\s*1;\s*\n\s*pointer-events:\s*auto;/,
  );
  // The row itself stays clickable where the hidden control used to swallow
  // the click, and spelled-out controls never double-fire the row.
  assert.match(sidebarSource, /if \(target\?\.closest\("button, \[data-action\]"\)\) return;/);
  assert.match(sidebarSource, /className=\{`thread-item[\s\S]*?onClick=\{\(event\) => \{/);
});

test("session rows reveal inline pin and archive actions ahead of the overflow menu", () => {
  const rowActions =
    sidebarSource.match(/<div className="sidebar-row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";

  // The cluster reads overflow, pin, archive from the left, and the overflow
  // trigger keeps the `session-menu` anchor the row context menu is anchored to.
  assert.match(
    rowActions,
    /data-action="session-menu"[\s\S]*?data-action="toggle-session-pin"[\s\S]*?data-action="toggle-session-archive"/,
  );
  // One shared class reveals all three, so a fourth control needs no new rule.
  assert.equal(rowActions.match(/thread-item-action/g)?.length, 3);
  // Each trigger runs the same action the row menu item runs, and stops the
  // click before it reaches the row that opens the session.
  assert.match(rowActions, /toggleSessionPin\(session\)/);
  assert.match(rowActions, /void archiveSession\(session\)/);
  assert.equal(rowActions.match(/event\.stopPropagation\(\)/g)?.length, 3);
  // The pin trigger fills with the row state, so the two states read apart
  // from the row alone.
  //
  // The state is the angle, not the fill. The icon set has no pinned glyph of
  // its own, and filling the outline turned a state marker into what looked
  // like a different, heavier icon — at this size the solid head no longer
  // read as a pin. The outline stays unfilled and the row state rotates it.
  assert.match(
    rowActions,
    /<IconPin size=\{14\} fill="none" className=\{cx\("session-pin-action", pinned && "is-pinned"\)\} \/>/,
  );
  assert.doesNotMatch(sidebarSource, /fill=\{pinned \? "currentColor" : "none"\}/);
  // Both pins take the angle, so the glyph reads the same wherever it appears.
  // The slot does not clip, so the rotated pin filling its 13px box is safe.
  assert.match(
    globalStyles,
    /\.thread-item-pin,\s*\.session-pin-action\.is-pinned\s*\{[^}]*transform:\s*rotate\(45deg\);/s,
  );
  // The archive trigger swaps its glyph so the state is readable without
  // opening a menu, and both labels follow the row state.
  assert.match(
    rowActions,
    /\{archived \? <IconArchiveRestore size=\{14\} \/> : <IconArchive size=\{14\} \/>\}/,
  );
  assert.match(
    sidebarSource,
    /const pinAction = pinned[\s\S]*?nav\.unpinTask[\s\S]*?nav\.pinTask/,
  );
  assert.match(
    sidebarSource,
    /const archiveAction = archived[\s\S]*?nav\.restoreTask[\s\S]*?nav\.archiveTask/,
  );
});

test("a blurred window releases latched row hover and actions", () => {
  assert.match(sidebarSource, /const \[windowFocused, setWindowFocused\] = useState\(true\)/);
  assert.match(sidebarSource, /window\.addEventListener\("focus", onWindowFocus\)/);
  assert.match(sidebarSource, /window\.addEventListener\("blur", onWindowBlur\)/);
  assert.match(sidebarSource, /data-window-blur=\{windowFocused \? undefined : "true"\}/);
  assert.match(
    globalStyles,
    /\.sidebar\[data-window-blur="true"\] \.thread-item:hover:not\(\.active\),\s*\.sidebar\[data-window-blur="true"\] \.project-group:not\(\.is-drop-target\) > \.sidebar-session-group-header:hover\s*\{[^}]*background:\s*transparent;/s,
  );
  assert.match(
    globalStyles,
    /\.sidebar\[data-window-blur="true"\] \.thread-item:hover \.thread-item-action:not\(\[aria-expanded="true"\]\),[\s\S]*?opacity:\s*0;\s*\n\s*pointer-events:\s*none;/,
  );
});

test("sidebar rows share one hover surface and workspace context never paints selection", () => {
  assert.match(
    globalStyles,
    /\.thread-item,\s*\.sidebar-session-group-header\s*\{[^}]*border-radius:\s*var\(--radius-sm\);[^}]*transition:/,
  );
  assert.match(
    globalStyles,
    /\.thread-item:hover,\s*\.thread-item.active,\s*\.project-group > \.sidebar-session-group-header:hover\s*\{[^}]*background:\s*var\(--ds-bg-hover\);/,
  );
  assert.match(globalStyles, /\.thread-item.active\s*\{[^}]*background:\s*var\(--ds-bg-active\);/);
  assert.match(globalStyles, /\.sidebar-session-group-title\s*\{[^}]*background:\s*transparent;[^}]*color:\s*inherit;/);
  assert.doesNotMatch(globalStyles, /\.project-group\.active/);
  assert.doesNotMatch(globalStyles, /\.sidebar-session-group-title\.project-toggle:hover/);
  assert.match(sidebarSource, /data-current-workspace=\{entry\.active \? "true" : undefined\}/);
  assert.match(globalStyles, /:focus-visible\s*\{[^}]*outline:\s*1\.5px solid/);
  assert.match(globalStyles, /\.project-group\.is-drop-target > \.sidebar-session-group-header\s*\{[^}]*outline:[^}]*background:/);
  assert.match(globalStyles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.thread-item,\s*\.sidebar-session-group-header\s*\{\s*transition-duration:\s*0\.01ms !important;/);
});

test("pinned projects render as their own group above the list", () => {
  // Pinning moves a project out of the main list, so the two are drawn from
  // disjoint slices of one sorted list rather than filtered at render time —
  // that way each half keeps the order the chosen sort gave it.
  assert.match(
    sidebarSource,
    /const pinnedProjectEntries = useMemo\(\s*\(\) => projectEntries\.filter\(\(entry\) => entry\.meta\.pinned\)/,
  );
  assert.match(
    sidebarSource,
    /const listedProjectEntries = useMemo\(\s*\(\) => projectEntries\.filter\(\(entry\) => !entry\.meta\.pinned\)/,
  );

  // Both halves carry the zone a cross-bucket drag resolves against. It has to
  // sit on the containers: the half being entered can be empty, and a row-level
  // marker would leave nothing to hit.
  assert.match(
    sidebarSource,
    /className=\{`sidebar-pinned-projects[^`]*`\}\s*\n\s*data-sidebar-project-pin-zone="pinned"/,
  );
  assert.match(
    sidebarSource,
    /className=\{`sidebar-listed-projects[^`]*`\}\s*\n\s*data-sidebar-project-pin-zone="rest"/,
  );
  assert.match(sidebarSource, /pinnedProjectEntries\.map\(renderProjectGroup\)/);
  // Beside the projects section, not inside it. Nested, it read as "projects,
  // which contain a pinned subgroup" and the two labels stacked.
  assert.match(
    sidebarSource,
    /data-sidebar-project-pin-zone="pinned"[\s\S]*?<\/section>\s*\) : null\}\s*<div\s*\n\s*className="sidebar-list-toolbar"\s*\n\s*data-sidebar-section="projects"/,
  );
  // It is outside the projects scroller, so it carries its own bound rather
  // than letting pinned projects push the projects off the bottom.
  assert.match(sidebarSource, /className="sidebar-pinned-projects-body"/);
  assert.match(
    globalStyles,
    /\.sidebar-pinned-projects-body\s*\{[^}]*padding-top:\s*2px;[^}]*max-height:[^}]*overflow-y:\s*auto;/s,
  );
  // Its last group gives up the 7px of air an expanded group normally owns,
  // so the section below is the same distance away whether the group is open
  // or shut.
  assert.match(
    globalStyles,
    /\.sidebar-pinned-projects-body > :last-child \.sidebar-session-group-list[\s\S]*?padding-bottom:\s*0;/,
  );
  // Both halves re-declare the 1px gap the flex container used to give them.
  assert.match(
    globalStyles,
    /\.sidebar-pinned-projects,\s*\.sidebar-listed-projects\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*1px;/s,
  );
  assert.match(sidebarSource, /listedProjectEntries\.map\(renderProjectGroup\)/);
  assert.match(sidebarSource, /t\("nav\.pinnedProjects"\)/);

  // A row no longer carries a pin badge: being in the group is the marker.
  assert.doesNotMatch(sidebarSource, /className="sidebar-project-pin"/);
});

test("dragging a project across the list boundary pins or unpins it", () => {
  // Reorder already refuses to cross a pin boundary, so the same boundary is
  // where a pin or unpin is offered instead — decided on release, from the
  // zone the pointer is over rather than from a row, so an empty half still
  // accepts a drop.
  assert.match(sidebarSource, /projectPinZoneFromPoint\(/);
  assert.match(sidebarSource, /zone !== projectPinZoneOf\(source\.meta\)/);
  assert.match(
    sidebarSource,
    /toggleProjectPinnedRef\.current\(source\.path, current\.pinZone === "pinned"\)/,
  );
  // The action is read through a ref: the pointer listeners are registered once
  // and live for the whole drag, so a captured store action would go stale.
  assert.match(sidebarSource, /const toggleProjectPinnedRef = useRef\(toggleProjectPinned\)/);
  // The highlight is transient state and has to be dropped on every way a drag
  // can end, or a released row leaves a zone lit.
  assert.match(sidebarSource, /setPinnedDropZone\(null\)/);
  assert.match(
    globalStyles,
    /\.sidebar-pinned-projects\.is-pin-drop-target,\s*\.sidebar-listed-projects\.is-pin-drop-target\s*\{/s,
  );
});
