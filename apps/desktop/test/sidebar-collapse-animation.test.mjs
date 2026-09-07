import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const topbarSource = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("the sidebar forwards collapse-animation props to the aside element", () => {
  // The aside must accept a className (the exit flag) and an animation-end
  // callback so App can keep it mounted through the exit keyframe, then unmount.
  assert.match(sidebarSource, /cx\("sidebar", className\)/);
  assert.match(sidebarSource, /onAnimationEnd=\{onAnimationEnd\}/);
  assert.match(sidebarSource, /className\?:\s*string;/);
  assert.match(
    sidebarSource,
    /onAnimationEnd\?:\s*ReactAnimationEventHandler<HTMLElement>;/,
  );
});

test("collapsing keeps the sidebar mounted until its exit animation ends", () => {
  // Mirror the work-panel mount-then-animate-then-unmount state machine: the
  // sidebar stays in the tree while `sidebarExiting` is true, gets the
  // `is-exiting` class, and fires `handleSidebarAnimationEnd` on animation end.
  assert.match(appSource, /!sidebarCollapsed \|\| sidebarExiting \?/);
  assert.match(
    appSource,
    /className=\{sidebarExiting \? "is-exiting" : undefined\}/,
  );
  assert.match(appSource, /onAnimationEnd=\{handleSidebarAnimationEnd\}/);
  assert.match(
    appSource,
    /if \(!event\.animationName\.startsWith\("sidebar-out"\)\) return;/,
  );
  // Expanding from the collapsed titlebar must route through the same machine
  // so the entrance animation plays too.
  assert.match(
    appSource,
    /CollapsedTitlebarActions[\s\S]*?onToggleSidebar/,
  );
});

test("the sidebar entrance/exit keyframes and exit rule exist", () => {
  // Entrance animation applied to every mount (matches the work-panel dock).
  const sidebarBlock = globalStyles.match(/\.sidebar\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(
    sidebarBlock,
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

test("a collapsed sidebar uses a narrower centered chat content band", () => {
  assert.match(
    appSource,
    /sidebarCollapsed && "sidebar-collapsed"/,
  );

  const mainPaneBlock = globalStyles.match(/\.main-pane\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(mainPaneBlock, /--chat-content-max-width:\s*760px/);
  assert.match(mainPaneBlock, /--chat-composer-max-width:\s*768px/);

  const collapsedBlock =
    globalStyles.match(/\.app-shell\.sidebar-collapsed \.main-pane\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(collapsedBlock, /--chat-content-max-width:\s*640px/);
  assert.match(collapsedBlock, /--chat-composer-max-width:\s*640px/);
  assert.match(
    collapsedBlock,
    /--chat-width-transition:\s*var\(--motion-duration-fast\) var\(--motion-ease-in\)/,
  );

  const threadContentBlock =
    globalStyles.match(/\.thread-content\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(threadContentBlock, /width:\s*min\(100%,\s*var\(--chat-content-max-width\)\)/);
  assert.match(threadContentBlock, /transition:\s*width var\(--chat-width-transition\)/);

  const homeStackBlock =
    globalStyles.match(/\.home-stack-inner\s*\{[\s\S]*?\}/)?.[0] ?? "";
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
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\] \.conversation-topbar\.ct-collapsed\s*\{[^}]*--ct-lead-inset:\s*76px/,
  );
  assert.match(
    globalStyles,
    /:root\[data-platform="darwin"\]\[data-fullscreen="true"\] \.conversation-topbar\.ct-collapsed\s*\{[^}]*--ct-lead-inset:\s*8px/,
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

test("the sidebar toggle never captures a stale collapsed state", () => {
  // The keydown and native-menu handlers register once; toggleSidebar must be
  // a stable callback driven by a functional update. Otherwise the second
  // Cmd/Ctrl+B reuses the first render's closure (collapsed=false) and keeps
  // collapsing instead of re-expanding the sidebar.
  assert.match(
    appSource,
    /const toggleSidebar = useCallback\(\(\) => \{\s*setSidebarCollapsed\(\(collapsed\) => !collapsed\);/,
  );
  assert.match(appSource, /\},\s*\[\]\);/);
  // The exit flag is adjusted during render, never in an effect: an effect runs
  // after the commit, so the collapsing render unmounts the dock outright and
  // the effect remounts it — one painted frame with no dock at all.
  assert.match(
    appSource,
    /const prevSidebarCollapsed = useRef\(sidebarCollapsed\);\s*if \(prevSidebarCollapsed\.current !== sidebarCollapsed\) \{\s*prevSidebarCollapsed\.current = sidebarCollapsed;\s*setSidebarExiting\(sidebarCollapsed\);\s*\}/,
  );
  assert.doesNotMatch(
    appSource,
    /useEffect\(\(\) => \{\s*setSidebarExiting\(sidebarCollapsed\);\s*\},\s*\[sidebarCollapsed\]\);/,
  );
  // Both shortcut dispatch paths depend on the stable toggle.
  assert.match(appSource, /\[showToast, toggleSidebar\],/);
  assert.match(appSource, /settings\?\.keybindings,\s*toggleSidebar,/);
});
