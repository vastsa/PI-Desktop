import { readAppSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const topbarSource = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("the sidebar forwards collapse-animation props to the aside element", () => {
  assert.match(sidebarSource, /cx\("sidebar", "sidebar-surface", className\)/);
  assert.match(sidebarSource, /onAnimationEnd=\{onAnimationEnd\}/);
  assert.match(sidebarSource, /className\?:\s*string;/);
  assert.match(sidebarSource, /onAnimationEnd\?:\s*ReactAnimationEventHandler<HTMLElement>;/);
});

test("collapsing keeps the sidebar mounted until its exit animation ends", () => {
  assert.match(appSource, /!sidebarCollapsed \|\| sidebarExiting \?/);
  assert.match(appSource, /className=\{cx\(sidebarEntering && "is-entering", sidebarExiting && "is-exiting"\)\}/);
  assert.match(appSource, /onAnimationEnd=\{handleSidebarAnimationEnd\}/);
  assert.match(appSource, /event\.target !== event\.currentTarget/);
  assert.match(appSource, /!event\.animationName\.startsWith\(expected\)/);
  assert.match(appSource, /CollapsedTitlebarActions[\s\S]*?onToggleSidebar/);
});

test("only explicit sidebar entrance plays the expand keyframe", () => {
  const sidebarBlock = globalStyles.match(/\.sidebar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(sidebarBlock, /animation:/);
  const entranceBlock = globalStyles.match(/\.sidebar\.is-entering\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(
    entranceBlock,
    /animation:\s*sidebar-in var\(--motion-duration-normal\) var\(--motion-ease-out\) both/,
  );
  // Exit rule swaps to the sidebar-out keyframe and blocks interaction.
  const exitingBlock =
    globalStyles.match(/\.sidebar\.is-exiting\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(exitingBlock, /pointer-events:\s*none/);
  assert.match(
    exitingBlock,
    /animation:\s*sidebar-out var\(--motion-duration-fast\) var\(--motion-ease-in\) both/,
  );
  // Both keyframes are declared, and the win32 variant keeps the dock opaque.
  assert.match(globalStyles, /@keyframes sidebar-in\s*\{/);
  assert.match(globalStyles, /@keyframes sidebar-out\s*\{/);
  assert.match(globalStyles, /@keyframes sidebar-out-windows\s*\{/);
  assert.match(
    globalStyles,
    /@keyframes sidebar-in\s*\{[\s\S]*?flex-basis:\s*0;[\s\S]*?width:\s*0;[\s\S]*?flex-basis:\s*var\(--ds-sidebar-width\);/,
  );
  assert.match(
    globalStyles,
    /@keyframes sidebar-out\s*\{[\s\S]*?flex-basis:\s*0;[\s\S]*?width:\s*0;/,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="win32"\] \.sidebar\.is-exiting\s*\{[\s\S]*?animation-name:\s*sidebar-out-windows/,
  );
});

test("the collapse keyframes cannot reflow the sidebar's content", () => {
  // The dock animates its own box width, so the content layer must be pinned to
  // the full dock width: otherwise every frame re-wraps the section labels and
  // re-runs the ellipsis on every session row, which reads as flicker.
  const contentBlock =
    globalStyles.match(/\.sidebar-header,\n\.sidebar-body\s*\{[\s\S]*?\}/)?.[0] ?? "";
  // The dock draws no edge stroke (D297), so the pin is the full dock width and
  // a no-op at rest.
  assert.match(contentBlock, /min-width:\s*var\(--ds-sidebar-width\)/);
  // `overflow: hidden` on the dock is what turns the pinned content into a wipe.
  const sidebarBlock = globalStyles.match(/\.sidebar\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(sidebarBlock, /overflow:\s*hidden/);
});

test("a collapsed sidebar keeps the preferred chat band and only changes motion", () => {
  assert.match(
    appSource,
    /sidebarCollapsed && "sidebar-collapsed"/,
  );

  const mainPaneBlock = globalStyles.match(/\.main-pane\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(mainPaneBlock, /--chat-content-max-width:\s*760px/);
  assert.match(
    mainPaneBlock,
    /--chat-composer-max-width:\s*var\(--chat-content-max-width\)/,
  );
  assert.match(
    mainPaneBlock,
    /--chat-prose-max-width:\s*var\(--chat-content-max-width\)/,
  );

  const collapsedBlock =
    globalStyles.match(/\.app-shell\.sidebar-collapsed \.main-pane\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.doesNotMatch(collapsedBlock, /--chat-content-max-width:\s*640px/);
  assert.doesNotMatch(collapsedBlock, /--chat-composer-max-width:\s*640px/);
  assert.match(
    collapsedBlock,
    /--chat-width-transition:\s*var\(--motion-duration-fast\) var\(--motion-ease-in\)/,
  );

  const threadContentBlock =
    globalStyles.match(/^\.thread-content\s*\{[\s\S]*?\}/m)?.[0] ?? "";
  assert.match(threadContentBlock, /width:\s*min\(100%,\s*var\(--chat-content-max-width\)\)/);
  assert.match(threadContentBlock, /transition:\s*width var\(--chat-width-transition\)/);

  const homeStackBlock =
    globalStyles.match(/^\.home-stack-inner\s*\{[\s\S]*?\}/m)?.[0] ?? "";
  assert.match(homeStackBlock, /width:\s*min\(100%,\s*var\(--chat-composer-max-width\)\)/);
  assert.match(homeStackBlock, /transition:\s*width var\(--chat-width-transition\)/);

  const composerBlock =
    globalStyles.match(/^\.composer-stack\s*\{[\s\S]*?\}/m)?.[0] ?? "";
  assert.match(
    composerBlock,
    /width:\s*min\(100%,\s*var\(--chat-composer-max-width,\s*768px\)\)/,
  );
  assert.match(composerBlock, /transition:\s*width var\(--chat-width-transition/);
});

test("the top bar's collapsed lead-in tracks the dock instead of snapping", () => {
  // The traffic-light inset and the returning dock toggle add ~100px to the top
  // bar's left edge. Flipping them instantly throws the title the wrong way on
  // the first frame, so both animate — and on the same curves as the dock:
  // sidebar-in timing while expanding, sidebar-out timing while collapsing.
  const topbarBlock =
    globalStyles.match(/\.conversation-topbar\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(
    topbarBlock,
    /transition:\s*padding-left var\(--motion-duration-normal\) var\(--motion-ease-out\)/,
  );
  const collapsedBlock =
    globalStyles.match(/\.conversation-topbar\.ct-collapsed\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(
    collapsedBlock,
    /transition:\s*padding-left var\(--motion-duration-fast\) var\(--motion-ease-in\)/,
  );

  const leadBlock =
    globalStyles.match(/\.conversation-topbar \.ct-lead\s*\{[\s\S]*?\}/)?.[0] ?? "";
  // Out of flow, so it reserves no width to animate. An in-flow slot has to
  // grow from 0 to 28px, and `overflow: hidden` then slices the glyph down the
  // middle for the whole transition — the icon reads as a torn shard.
  assert.match(leadBlock, /position:\s*absolute/);
  // `left` and the title's `padding-left` must cover the same distance, or the
  // button drifts onto the title mid-transition even though both endpoints look
  // right. Both are derived from --ct-lead-inset, 36px apart.
  assert.match(leadBlock, /left:\s*calc\(var\(--ct-lead-inset\) - 36px\)/);
  assert.doesNotMatch(leadBlock, /overflow:\s*hidden/);
  assert.doesNotMatch(leadBlock, /width:\s*0/);
  assert.match(leadBlock, /opacity:\s*0/);
  assert.match(leadBlock, /pointer-events:\s*none/);
  // Out of flow means .ct-left's no-drag box (which starts at the padding edge)
  // no longer covers the button, so it must carve out its own region or the top
  // bar's drag region swallows the click and the pointer cursor.
  assert.match(leadBlock, /-webkit-app-region:\s*no-drag/);
  assert.match(leadBlock, /\n\s*app-region:\s*no-drag/);
  assert.match(leadBlock, /opacity var\(--motion-duration-normal\) var\(--motion-ease-out\)/);
  const leadCollapsedBlock =
    globalStyles.match(
      /\.conversation-topbar\.ct-collapsed \.ct-lead\s*\{[\s\S]*?\}/,
    )?.[0] ?? "";
  assert.match(leadCollapsedBlock, /left:\s*var\(--ct-lead-inset\)/);
  assert.match(leadCollapsedBlock, /opacity:\s*1/);
  assert.match(leadCollapsedBlock, /opacity var\(--motion-duration-fast\) var\(--motion-ease-in\)/);

  // Because the slot is out of flow, the title's collapsed offset must be
  // derived from the same inset the button is positioned at, or the two drift.
  assert.match(collapsedBlock, /padding-left:\s*calc\(var\(--ct-lead-inset\) \+ 36px\)/);
  const topbarBaseBlock =
    globalStyles.match(/\.conversation-topbar\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(topbarBaseBlock, /--ct-lead-inset:\s*12px/);
  // The collapsed inset is the shared traffic-light reserve; its darwin value
  // (native footprint + gap, 8px in fullscreen) lives in one place, asserted by
  // test/traffic-light-reserve.test.mjs.
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.conversation-topbar\.ct-collapsed\s*\{[^}]*--ct-lead-inset:\s*var\(--ds-window-lead-inset\)/,
  );

  // The button stays mounted so it can cross-fade with the dock's own toggle;
  // unmounting it would restore the first-frame jump. Hidden from AT and taken
  // out of the tab order while the dock is open.
  assert.match(topbarSource, /<div className="ct-lead" aria-hidden=\{!sidebarCollapsed\}>/);
  assert.match(topbarSource, /tabIndex=\{sidebarCollapsed \? undefined : -1\}/);
  assert.doesNotMatch(topbarSource, /\{sidebarCollapsed \? \(\s*<button/);
});

test("reduced motion drops the collapse animation and its top-bar tracking", () => {
  assert.match(
    globalStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar\.is-exiting[\s\S]*?animation-duration:\s*0\.01ms !important/,
  );
  assert.match(
    globalStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.conversation-topbar \.ct-lead[\s\S]*?transition-duration:\s*0\.01ms !important/,
  );
});

/** One CSS rule's declarations, with its comments removed. */
function rule(selector) {
  const block =
    globalStyles.match(new RegExp(`${selector}\\s*\\{[\\s\\S]*?\\}`))?.[0] ?? "";
  return block.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("a project group folds as one grid row instead of a max-height wipe", () => {
  const projectRule = rule(String.raw`\.sidebar-session-group-body\.project`);
  assert.match(projectRule, /display:\s*grid/);
  assert.match(projectRule, /grid-template-rows:\s*1fr/);
  assert.match(
    projectRule,
    /transition:\s*grid-template-rows var\(--motion-duration-normal\) var\(--motion-ease-out\)/,
  );
  // A height clamp and an opacity transition are the two ways this fold can be
  // staged apart from the row the rows are laid out in.
  assert.doesNotMatch(projectRule, /max-height/);
  assert.doesNotMatch(projectRule, /opacity/);
  assert.doesNotMatch(projectRule, /padding-(top|bottom)/);

  const collapsedRule = rule(
    String.raw`\.sidebar-session-group-body\.project\.collapsed`,
  );
  assert.match(collapsedRule, /grid-template-rows:\s*0fr/);
  assert.match(collapsedRule, /pointer-events:\s*none/);
  // The rows leave by being clipped, so nothing fades and nothing keeps a
  // height of its own.
  assert.doesNotMatch(collapsedRule, /opacity/);
  assert.doesNotMatch(collapsedRule, /max-height/);

  // The shared body rule must not carry either one onto the project body, and
  // the pinned and standalone bodies keep the plain column.
  const baseRule = rule(String.raw`\.sidebar-session-group-body`);
  assert.match(baseRule, /display:\s*flex/);
  assert.match(baseRule, /flex-direction:\s*column/);
  assert.doesNotMatch(baseRule, /max-height/);
  assert.doesNotMatch(baseRule, /opacity/);
  assert.doesNotMatch(baseRule, /grid-template-rows/);
});

test("the clip closes the 0fr row and the list owns the group inset", () => {
  const clipRule = rule(String.raw`\.sidebar-session-group-clip`);
  assert.match(clipRule, /min-height:\s*0/);
  assert.match(clipRule, /overflow:\s*hidden/);
  // Vertical padding on the animating box or on the clip holds the 0fr row open
  // and leaves a tail behind after the rows are gone.
  assert.doesNotMatch(clipRule, /padding/);

  const listRule = rule(String.raw`\.sidebar-session-group-list`);
  assert.match(listRule, /display:\s*flex/);
  assert.match(listRule, /flex-direction:\s*column/);
  assert.match(listRule, /gap:\s*1px/);
  assert.match(listRule, /padding-top:\s*2px/);
  assert.match(listRule, /padding-bottom:\s*7px/);

  // The 8px tail is the list's own 7px plus the scroller's 1px gap, so an
  // expanded group is followed by 8px and a collapsed one by 1px either way.
  assert.match(rule(String.raw`\.sidebar-session-groups`), /gap:\s*1px/);
});

test("the project body renders the grid, clip, and list layers", () => {
  assert.match(
    sidebarSource,
    /className=\{`sidebar-session-group-body project \$\{collapsedProject \? "collapsed" : ""\}`\}/,
  );
  assert.match(sidebarSource, /aria-hidden=\{collapsedProject\}/);
  // `inert` is the React 19 boolean form, and only while folded: the rows stay
  // mounted inside the 0fr row, so they must leave the tab order as well as the
  // accessibility tree.
  assert.match(sidebarSource, /inert=\{collapsedProject \? true : undefined\}/);
  assert.match(
    sidebarSource,
    /<div className="sidebar-session-group-clip">\s*<div className="sidebar-session-group-list">/,
  );
  // The list layer has to be innermost, or the rows sit outside the inset the
  // fold is supposed to carry away.
  assert.match(
    sidebarSource,
    /sidebar-session-group-list">\s*\{entry\.sessions\.length > 0 \? renderTimeGroupedSessions\(visibleSessions\) : \(/,
  );
});

test("reduced motion keeps the fold's endpoints and drops its travel", () => {
  assert.match(
    globalStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-session-group-body\.project\s*\{\s*transition-duration:\s*0\.01ms !important;/,
  );
});

test("the sidebar toggle never captures a stale collapsed state", () => {
  // The keydown and native-menu handlers register once; toggleSidebar reads the
  // shell state through refs and spends work-panel width on reopen, so the old
  // functional-update form must not come back.
  assert.match(appSource, /const toggleSidebar = useCallback\(\(\) => \{/);
  assert.match(appSource, /if \(sidebarCollapsedRef\.current\) reopenSidebar\(\);/);
  assert.match(appSource, /else setSidebarCollapsed\(true\);/);
  assert.doesNotMatch(
    appSource,
    /setSidebarCollapsed\(\(collapsed\) => !collapsed\)/,
  );
  assert.match(appSource, /useSidebarTransition\(\s*sidebarCollapsed,\s*ready && page !== "settings"/);
  assert.match(appSource, /if \(current !== transition\) setTransition\(current\)/);
  assert.match(appSource, /return \(\) => window\.clearTimeout\(timer\)/);
  assert.match(appSource, /state === current \? \{ \.\.\.state, phase: "idle" \} : state/);
  // Both shortcut dispatch paths depend on the stable toggle.
  assert.match(appSource, /\[showToast, toggleSidebar\],/);
  assert.match(appSource, /settings\?\.keybindings,\s*toggleSidebar,/);
});
