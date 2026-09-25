/**
 * `pi.ui.injectStyle` (`slot-contract.html` §4).
 *
 * A plugin's style sheet applies inside its own mounts only: its style rules
 * go into `@scope ([data-pi-plugin="<id>"])`, the attribute every
 * `SlotBoundary` carries. Rules that name things instead of selecting
 * elements (`@keyframes`, `@font-face`, `@property`, `@layer` statements, ...)
 * cannot be scoped and stay global, so a plugin's names share the document's
 * namespace. `@import` is dropped: a sheet brings its rules along rather than
 * fetching more.
 *
 * The browser parses the sheet first (`CSSStyleSheet.replaceSync`), so what
 * gets scoped is what the CSS engine understood, never a text match. Scoping
 * keeps well-behaved plugins apart and out of the host's way; it is not a
 * boundary, since same-realm code can restyle anything (an accepted cost).
 */
import type { PluginDisposer } from "@pi-desktop/plugin-sdk";

/** What the scoper reads of a parsed rule; a `CSSRule` in the app. */
export type ParsedCssRule = {
  readonly cssText: string;
  readonly constructor: { readonly name: string };
};

/** Rules that hold style rules and are valid inside `@scope`. */
const SCOPED_RULES = new Set([
  "CSSStyleRule",
  "CSSMediaRule",
  "CSSSupportsRule",
  "CSSContainerRule",
  "CSSLayerBlockRule",
  "CSSScopeRule",
  "CSSStartingStyleRule",
]);

const DROPPED_RULES = new Set(["CSSImportRule"]);

function cssString(value: string): string {
  return `"${value.replace(/["\\\n]/g, (char) => (char === "\n" ? "\\a " : `\\${char}`))}"`;
}

/**
 * The text of a plugin's sheet as the host injects it: global at-rules first,
 * in source order, then every style rule inside the plugin's scope.
 */
export function scopedPluginCss(pluginId: string, rules: Iterable<ParsedCssRule>): string {
  const global: string[] = [];
  const scoped: string[] = [];
  for (const rule of rules) {
    const kind = rule.constructor.name;
    if (DROPPED_RULES.has(kind)) continue;
    (SCOPED_RULES.has(kind) ? scoped : global).push(rule.cssText);
  }
  if (scoped.length) {
    global.push(`@scope ([data-pi-plugin=${cssString(pluginId)}]) {\n${scoped.join("\n")}\n}`);
  }
  return global.join("\n");
}

/** Inject one sheet for `pluginId`; the disposer removes it. */
export function injectPluginStyle(pluginId: string, css: string): PluginDisposer {
  if (typeof css !== "string") throw new TypeError("injectStyle takes a CSS string");
  const parsed = new CSSStyleSheet();
  parsed.replaceSync(css);
  const element = document.createElement("style");
  element.setAttribute("data-pi-plugin-style", pluginId);
  element.textContent = scopedPluginCss(pluginId, Array.from(parsed.cssRules));
  document.head.appendChild(element);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    element.remove();
  };
}
