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
  assert.doesNotMatch(sidebarSource, /data-nav="pulls"/);
  assert.match(sidebarSource, /data-nav="scheduled"/);
  assert.doesNotMatch(sidebarSource, /t\("nav\.(?:pullRequests|scheduled)"\)/);
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

test("pinned project rows replace the folder glyph with a filled star", () => {
  assert.match(
    sidebarSource,
    /entry\.meta\.pinned \? \([\s\S]*?<IconStar\s+size=\{13\}\s+fill="currentColor"[\s\S]*?className="sidebar-project-pin"[\s\S]*?\) : \([\s\S]*?<IconFolder size=\{13\} aria-hidden \/>/,
  );
  assert.match(
    globalStyles,
    /\.sidebar-project-pin\s*\{[^}]*flex:\s*0 0 auto;[^}]*color:\s*var\(--ds-accent\);/s,
  );
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
  assert.match(globalStyles, /\.thread-item:hover \.thread-item-more,/);
  assert.match(
    globalStyles,
    /\.sidebar-session-group-header:hover \.thread-item-more,[\s\S]*?\.sidebar-session-group-header:focus-within \.thread-item-more,/,
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

test("hidden row actions stay out of the row's click path", () => {
  // Resting state: the invisible control is not a pointer target at all.
  assert.match(
    globalStyles,
    /\.thread-item-more\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*\}/s,
  );
  assert.match(
    globalStyles,
    /\.thread-item:focus-within \.thread-item-more,\s*\n\.thread-item-more:focus-visible\s*\{[^}]*pointer-events:\s*auto;/s,
  );
  // Without hover there is no reveal, so a no-hover pointer gets the controls
  // visible and tappable instead of an invisible gutter.
  assert.match(
    globalStyles,
    /@media \(hover: none\)\s*\{[\s\S]*?\.sidebar-row-actions \.thread-item-more,[\s\S]*?opacity:\s*1;\s*\n\s*pointer-events:\s*auto;/,
  );
  // The row itself stays clickable where the hidden control used to swallow
  // the click, and spelled-out controls never double-fire the row.
  assert.match(sidebarSource, /if \(target\?\.closest\("button, \[data-action\]"\)\) return;/);
  assert.match(sidebarSource, /className=\{`thread-item[\s\S]*?onClick=\{\(event\) => \{/);
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
    /\.sidebar\[data-window-blur="true"\] \.thread-item:hover \.thread-item-more:not\(\[aria-expanded="true"\]\),[\s\S]*?opacity:\s*0;\s*\n\s*pointer-events:\s*none;/,
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
