import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
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
  assert.doesNotMatch(sidebarSource, /data-nav="scheduled"/);
  assert.doesNotMatch(sidebarSource, /t\("nav\.(?:pullRequests|scheduled)"\)/);
});

test("sidebar brand returns to the chat home", () => {
  const brandButton = sidebarSource.match(
    /<button\s+type="button"\s+className="brand no-drag"[\s\S]*?<\/button>/,
  )?.[0] ?? "";

  assert.match(brandButton, /data-nav="home"/);
  assert.match(brandButton, /aria-label=\{t\("nav\.home"\)\}/);
  assert.match(brandButton, /onClick=\{\(\) => setPage\("chat"\)\}/);
  assert.match(brandButton, /<BrandLogo size=\{20\}/);
  assert.match(brandButton, /t\("app\.shellName"\)/);
});

test("sidebar header retains non-mac branding and keeps collapse beside search", () => {
  const header = sidebarSource.match(
    /<div className="sidebar-header">[\s\S]*?<\/div>\s*<\/div>/,
  )?.[0] ?? "";

  assert.match(header, /className="brand no-drag"/);
  assert.match(header, /className="sidebar-header-actions no-drag"/);
  assert.ok(header.indexOf("<IconSearch") < header.indexOf("<IconSidebar"));
  assert.match(header, /data-nav="toggle-sidebar"/);
  assert.doesNotMatch(appSource, /IconChevronLeft|IconChevronRight/);
});

test("work panel collapse control lives in the switcher menu", () => {
  assert.match(panelSource, /onCollapse/);
  assert.match(panelSource, /work-panel-toolbar-collapse/);
  assert.match(panelSource, /IconChevronRight/);
  assert.match(appSource, /collapseWorkPanel\(\)/);
  assert.doesNotMatch(panelSource, /work-panel-collapse/);
  assert.doesNotMatch(panelSource, /collapsePanel/);
  assert.match(
    globalStyles,
    /\.main-titlebar\.work-panel-open\s*\{[^}]*padding-right:\s*0;/s,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="win32"\] \.main-titlebar\.work-panel-open,[\s\S]*:root\[data-platform="linux"\] \.main-titlebar\.work-panel-open\s*\{[^}]*right:\s*var\(--ds-window-controls-width\);/,
  );
  assert.doesNotMatch(globalStyles, /\.work-panel-header\s*\{[^}]*margin-right:/s);
});

test("macOS hides sidebar branding and keeps header actions beside traffic lights", () => {
  assert.doesNotMatch(sidebarSource, /sidebar-macos-drag-row/);
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.sidebar-header\s*\{[^}]*padding-left:\s*76px;/s,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.sidebar-header > \.brand\s*\{[^}]*display:\s*none;/s,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\]\[data-fullscreen="true"\] \.sidebar-header\s*\{[^}]*padding-left:\s*8px;/s,
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
  assert.match(standaloneSessions, /renderSessionRows\(temporarySessions/);
  assert.ok(
    sidebarSource.indexOf('data-sidebar-session-section="temporary"') <
      sidebarSource.indexOf('data-action="new-project"'),
  );
  assert.match(
    globalStyles,
    /\.sidebar-session-group-body\.standalone\s*\{[\s\S]*?max-height:\s*140px;[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/,
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
  const defaultPopoverRuleIndex = globalStyles.indexOf(
    ".sidebar-popover {\n  top: calc(100% + 4px);\n  right: 0;\n}",
  );
  const floatingPopoverRuleIndex = globalStyles.indexOf(
    ".sidebar-popover.sidebar-floating-menu",
  );
  const floatingPopoverRule =
    globalStyles.match(/\.sidebar-popover\.sidebar-floating-menu\s*\{[^}]*\}/s)?.[0] ?? "";

  assert.ok(defaultPopoverRuleIndex >= 0);
  assert.ok(floatingPopoverRuleIndex > defaultPopoverRuleIndex);
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
    /className="sidebar-session-group-title project-toggle"[\s\S]*?aria-describedby=\{`\$\{projectId\}-path-description`\}[\s\S]*?onMouseEnter=\{\(event\) => showProjectPath\(entry, event\.currentTarget\)\}[\s\S]*?onFocus=\{\(event\) => showProjectPath\(entry, event\.currentTarget\)\}/,
  );
  assert.match(sidebarSource, /className="sidebar-project-path-tooltip"/);
  assert.match(sidebarSource, /role="tooltip"/);
  assert.match(sidebarSource, /className="sr-only">\s*\{entry\.path\}/);
  assert.match(
    globalStyles,
    /\.sidebar-project-path-tooltip\s*\{[^}]*position:\s*fixed;[^}]*max-width:[^;]*;[^}]*overflow-wrap:\s*anywhere;/s,
  );
});

test("session rows use the hover card instead of a native title tooltip", () => {
  const sessionMain = sidebarSource.match(
    /className="thread-item-main"[\s\S]*?<\/button>/,
  )?.[0] ?? "";

  assert.match(sessionMain, /showSessionHoverCard\(/);
  assert.doesNotMatch(sessionMain, /title=\{taskTitle\(session\.title\)\}/);
  assert.doesNotMatch(sessionMain, /\btitle=\{/);
  assert.match(sidebarSource, /className="sidebar-session-hover-card"/);
  assert.match(sidebarSource, /className="sidebar-session-hover-card-title"/);
});
